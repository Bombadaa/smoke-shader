'use strict';

const canvas = document.getElementById('glcanvas');
canvas.width = canvas.clientWidth;
canvas.height = canvas.clientHeight;

// Define default config values separately
const defaultConfig = {
    DENSITY_DISSIPATION: 0.98, // From user image
    VELOCITY_DISSIPATION: 1.0, // From user image
    PRESSURE: 1.0, // From user image
    SPLAT_RADIUS: 0.4, // From user image
    DENSITY_INTENSITY: 0.03, // From user image
    MOUSE_FORCE: 10.0, // From user image
    SMOKE_BRIGHTNESS: 0.75 // From user image
};

// Apply defaults initially to the main config
let config = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1024,
    CAPTURE_RESOLUTION: 512,
    DENSITY_DISSIPATION: defaultConfig.DENSITY_DISSIPATION,
    VELOCITY_DISSIPATION: defaultConfig.VELOCITY_DISSIPATION,
    PRESSURE: defaultConfig.PRESSURE,
    PRESSURE_ITERATIONS: 20,
    CURL: 0, // No curl for simpler smoke
    SPLAT_RADIUS: defaultConfig.SPLAT_RADIUS,
    SPLAT_FORCE: 1.0, // Keep this low, main force comes from mouse delta scaling
    DENSITY_INTENSITY: defaultConfig.DENSITY_INTENSITY,
    MOUSE_FORCE: defaultConfig.MOUSE_FORCE,
    SMOKE_BRIGHTNESS: defaultConfig.SMOKE_BRIGHTNESS,
    SHADING: false, // No complex shading
    COLORFUL: false, // Black and white
    COLOR_UPDATE_SPEED: 10,
    PAUSED: false,
    BACK_COLOR: { r: 0, g: 0, b: 0 },
    TRANSPARENT: false,
    BLOOM: false,
    BLOOM_ITERATIONS: 8,
    BLOOM_RESOLUTION: 256,
    BLOOM_INTENSITY: 0.8,
    BLOOM_THRESHOLD: 0.6,
    BLOOM_SOFT_KNEE: 0.7,
    SUNRAYS: false,
    SUNRAYS_RESOLUTION: 196,
    SUNRAYS_WEIGHT: 1.0,
}

function pointerPrototype () {
    this.id = -1;
    this.texcoordX = 0;
    this.texcoordY = 0;
    this.prevTexcoordX = 0;
    this.prevTexcoordY = 0;
    this.deltaX = 0;
    this.deltaY = 0;
    this.down = false;
    this.moved = false;
    this.color = [30, 30, 30]; // White/Gray smoke
}

let pointers = [];
let splatStack = [];
pointers.push(new pointerPrototype());

const { gl, ext } = getWebGLContext(canvas);

if (!ext.supportLinearFiltering) {
    config.DYE_RESOLUTION = 512;
    config.SHADING = false;
    config.BLOOM = false;
    config.SUNRAYS = false;
}

function getWebGLContext (canvas) {
    const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };

    let gl = canvas.getContext('webgl2', params);
    const isWebGL2 = !!gl;
    if (!isWebGL2)
        gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);

    let halfFloat;
    let supportLinearFiltering;
    if (isWebGL2) {
        gl.getExtension('EXT_color_buffer_float');
        supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
    }
    else {
        halfFloat = gl.getExtension('OES_texture_half_float');
        supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
    }

    gl.clearColor(0.0, 0.0, 0.0, 0.0);

    const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;
    let formatRGBA;
    let formatRG;
    let formatR;

    if (isWebGL2)
    {
        formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
        formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
        formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
    }
    else
    {
        formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    }

    return {
        gl,
        ext: {
            formatRGBA,
            formatRG,
            formatR,
            halfFloatTexType,
            supportLinearFiltering
        }
    };
}

function getSupportedFormat (gl, internalFormat, format, type)
{
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
        switch (internalFormat) {
            case gl.R16F: return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
            case gl.RG16F: return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
            default: return null;
        }
    }
    return { internalFormat, format };
}

function supportRenderTextureFormat (gl, internalFormat, format, type) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    return status == gl.FRAMEBUFFER_COMPLETE;
}

class Material {
    constructor (vertexShader, fragmentShaderSource) {
        this.vertexShader = vertexShader;
        this.fragmentShaderSource = fragmentShaderSource;
        this.programs = [];
        this.activeProgram = null;
        this.uniforms = [];
    }

    setKeywords (keywords) {
        let hash = 0;
        for (let i = 0; i < keywords.length; i++)
            hash += hashCode(keywords[i]);

        let program = this.programs[hash];
        if (program == null) {
            let fragmentShader = compileShader(gl.FRAGMENT_SHADER, this.fragmentShaderSource, keywords);
            program = createProgram(this.vertexShader, fragmentShader);
            this.programs[hash] = program;
        }

        if (program == this.activeProgram) return;

        this.uniforms = getUniforms(program);
        this.activeProgram = program;
    }

    bind () {
        gl.useProgram(this.activeProgram);
    }
}

class Program {
    constructor (vertexShader, fragmentShader) {
        this.uniforms = {};
        this.program = createProgram(vertexShader, fragmentShader);
        this.uniforms = getUniforms(this.program);
    }

    bind () {
        gl.useProgram(this.program);
    }
}

function createProgram (vertexShader, fragmentShader) {
    let program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);

    // Bind attribute location before linking
    gl.bindAttribLocation(program, 0, 'aPosition'); // Ensure aPosition is at location 0

    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        // Log error explicitly to console
        console.error("Program Link Error:", gl.getProgramInfoLog(program));
        throw gl.getProgramInfoLog(program);
    }

    return program;
}

function getUniforms (program) {
    let uniforms = {};
    let uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < uniformCount; i++) {
        let uniformName = gl.getActiveUniform(program, i).name;
        uniforms[uniformName] = gl.getUniformLocation(program, uniformName);
    }
    return uniforms;
}

function compileShader (type, source, keywords) {
    source = addKeywords(source, keywords);

    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        // Log error explicitly to console
        console.error(`Shader Compile Error in ${type === gl.VERTEX_SHADER ? 'Vertex' : 'Fragment'} Shader:`, gl.getShaderInfoLog(shader));
        throw gl.getShaderInfoLog(shader);
    }

    return shader;
};

function addKeywords (source, keywords) {
    if (keywords == null) return source;
    let keywordsString = '';
    keywords.forEach(keyword => {
        keywordsString += '#define ' + keyword + '\n';
    });
    return keywordsString + source;
}

const baseVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;

    void main () {
        vUv = aPosition * 0.5 + 0.5;
        vL = vUv - vec2(texelSize.x, 0.0);
        vR = vUv + vec2(texelSize.x, 0.0);
        vT = vUv + vec2(0.0, texelSize.y);
        vB = vUv - vec2(0.0, texelSize.y);
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`);

const clearShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    uniform float value;

    void main () {
        gl_FragColor = value * texture2D(uTexture, vUv);
    }
`);

const colorShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;

    varying vec2 vUv;

    uniform vec4 color;

    void main () {
        gl_FragColor = color;
    }
`);

const splatShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float aspectRatio;
    uniform vec3 color;
    uniform vec2 point;
    uniform float radius;

    void main () {
        vec2 p = vUv - point.xy;
        p.x *= aspectRatio;
        vec3 splat = exp(-dot(p, p) / radius) * color;
        vec3 base = texture2D(uTarget, vUv).xyz;
        gl_FragColor = vec4(base + splat, 1.0);
    }
`);

const advectionShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform vec2 dyeTexelSize;
    uniform float dt;
    uniform float dissipation;

    vec4 bilerp (sampler2D sam, vec2 uv) {
        vec2 st = uv / texelSize - 0.5;

        vec2 iuv = floor(st);
        vec2 fuv = fract(st);

        vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * texelSize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * texelSize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * texelSize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * texelSize);

        return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }

    void main () {
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        gl_FragColor = dissipation * bilerp(uSource, coord);
        gl_FragColor.a = 1.0;
    }
`);

const divergenceShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uVelocity, vL).x;
        float R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y;
        float B = texture2D(uVelocity, vB).y;

        vec2 C = texture2D(uVelocity, vUv).xy;
        if (vL.x < 0.0) { L = -C.x; }
        if (vR.x > 1.0) { R = -C.x; }
        if (vT.y > 1.0) { T = -C.y; }
        if (vB.y < 0.0) { B = -C.y; }

        float div = 0.5 * (R - L + T - B);
        gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }
`);

const pressureShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;

    void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        float C = texture2D(uPressure, vUv).x;
        float divergence = texture2D(uDivergence, vUv).x;
        float pressure = (L + R + B + T - divergence) * 0.25;
        gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
    }
`);

const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity.xy -= vec2(R - L, T - B);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`);

const displayShaderSource = `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;

    void main () {
        // Simple display of density (grayscale)
        float density = texture2D(uTexture, vUv).r;
        // Set alpha based on density
        gl_FragColor = vec4(vec3(density), density);
    }
`;

let dye;                  // Stores density
let velocity;             // Stores velocity
let divergence;
let pressure;

let simWidth;
let simHeight;
let dyeWidth;
let dyeHeight;
let dx;
let dy;

const clearProgram = new Program(baseVertexShader, clearShader);
const colorProgram = new Program(baseVertexShader, colorShader);
const splatProgram = new Program(baseVertexShader, splatShader);
const advectionProgram = new Program(baseVertexShader, advectionShader);
const divergenceProgram = new Program(baseVertexShader, divergenceShader);
const pressureProgram = new Program(baseVertexShader, pressureShader);
const gradienSubtractProgram = new Program(baseVertexShader, gradientSubtractShader);
const displayMaterial = new Material(baseVertexShader, displayShaderSource);
displayMaterial.setKeywords([]); // Initialize the material's program

function initFramebuffers () {
    let simRes = getResolution(config.SIM_RESOLUTION);
    let dyeRes = getResolution(config.DYE_RESOLUTION);

    simWidth = simRes.width;
    simHeight = simRes.height;
    dyeWidth = dyeRes.width;
    dyeHeight = dyeRes.height;

    dx = 1.0 / simWidth;
    dy = 1.0 / simHeight;

    const texType = ext.halfFloatTexType;
    const rgba = ext.formatRGBA;
    const rg = ext.formatRG;
    const r = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    gl.disable(gl.BLEND);

    if (dye == null)
        dye = createDoubleFBO(dyeWidth, dyeHeight, rgba.internalFormat, rgba.format, texType, filtering);
    else
        dye = resizeDoubleFBO(dye, dyeWidth, dyeHeight, rgba.internalFormat, rgba.format, texType, filtering);

    if (velocity == null)
        velocity = createDoubleFBO(simWidth, simHeight, rg.internalFormat, rg.format, texType, filtering);
    else
        velocity = resizeDoubleFBO(velocity, simWidth, simHeight, rg.internalFormat, rg.format, texType, filtering);

    divergence = createFBO      (simWidth, simHeight, r.internalFormat, r.format, texType, gl.NEAREST);
    pressure   = createDoubleFBO(simWidth, simHeight, r.internalFormat, r.format, texType, gl.NEAREST);

}

function getResolution (resolution) {
    let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspectRatio < 1) aspectRatio = 1.0 / aspectRatio;

    let min = Math.round(resolution);
    let max = Math.round(resolution * aspectRatio);

    if (gl.drawingBufferWidth > gl.drawingBufferHeight) return { width: max, height: min };
    else return { width: min, height: max };
}

function createFBO (w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let texelSizeX = 1.0 / w;
    let texelSizeY = 1.0 / h;

    return {
        texture,
        fbo,
        width: w,
        height: h,
        texelSizeX,
        texelSizeY,
        attach (id) {
            gl.activeTexture(gl.TEXTURE0 + id);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            return id;
        }
    };
}

function createDoubleFBO (w, h, internalFormat, format, type, param) {
    let fbo1 = createFBO(w, h, internalFormat, format, type, param);
    let fbo2 = createFBO(w, h, internalFormat, format, type, param);

    return {
        width: w,
        height: h,
        texelSizeX: fbo1.texelSizeX,
        texelSizeY: fbo1.texelSizeY,
        get read () {
            return fbo1;
        },
        set read (value) {
            fbo1 = value;
        },
        get write () {
            return fbo2;
        },
        set write (value) {
            fbo2 = value;
        },
        swap () {
            let temp = fbo1;
            fbo1 = fbo2;
            fbo2 = temp;
        }
    }
}

function resizeFBO (target, w, h, internalFormat, format, type, param) {
    let newFBO = createFBO(w, h, internalFormat, format, type, param);
    // Need a copy program if resizing is intended during runtime, but this basic example doesn't implement it.
    // For simplicity, we'll just return the new FBO without copying content.
    // If you need resizing with content preservation, implement a copy shader and program.
    // copyProgram.bind();
    // gl.uniform1i(copyProgram.uniforms.uTexture, target.attach(0));
    // blit(newFBO.fbo);
    gl.deleteFramebuffer(target.fbo);
    gl.deleteTexture(target.texture);
    return newFBO;
}

function resizeDoubleFBO (target, w, h, internalFormat, format, type, param) {
    target.read = resizeFBO(target.read, w, h, internalFormat, format, type, param);
    target.write = createFBO(w, h, internalFormat, format, type, param);
    target.width = w;
    target.height = h;
    target.texelSizeX = 1.0 / w;
    target.texelSizeY = 1.0 / h;
    return target;
}

function blit (target) {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); // Use a dummy buffer for vertex attributes
    // Setup vertex attribute pointer for aPosition (location 0)
    // This assumes your baseVertexShader uses `attribute vec2 aPosition;` at location 0
    const positionAttributeLocation = 0; // Explicitly use location 0
    gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(positionAttributeLocation);

    // Define vertices for a full-screen quad
    const vertices = new Float32Array([
        -1.0, -1.0,
         1.0, -1.0,
        -1.0,  1.0,
         1.0,  1.0,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target); // Target can be null for screen
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.disableVertexAttribArray(positionAttributeLocation); // Clean up
    gl.bindBuffer(gl.ARRAY_BUFFER, null); // Unbind buffer
}

initFramebuffers();

let lastTime = Date.now();
let colorUpdateTimer = 0.0;

update();

function update () {
    const dt = calcDeltaTime();
    if (resizeCanvas()) initFramebuffers();

    applyInputs(); // Apply inputs before updating physics/dye
    updateVelocity(dt);
    updateDye(dt);

    requestAnimationFrame(update);
}

function calcDeltaTime () {
    let now = Date.now();
    let dt = (now - lastTime) / 1000.0;
    dt = Math.min(dt, 0.016666);
    lastTime = now;
    return dt;
}

function resizeCanvas () {
    let width = canvas.clientWidth;
    let height = canvas.clientHeight;
    if (canvas.width != width || canvas.height != height) {
        canvas.width = width;
        canvas.height = height;
        return true;
    }
    return false;
}

function updateVelocity (dt) {
    gl.viewport(0, 0, simWidth, simHeight);

    // Advection
    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, dx, dy);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, velocity.read.attach(0));
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write.fbo);
    velocity.swap();

    // Divergence
    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, dx, dy);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence.fbo);

    // Pressure Calculation (Jacobi iterations)
    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE); // Use pressure value for initial clear? Might need 0.
    blit(pressure.write.fbo);
    pressure.swap();

    pressureProgram.bind();
    gl.uniform2f(pressureProgram.uniforms.texelSize, dx, dy);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
        blit(pressure.write.fbo);
        pressure.swap();
    }

    // Gradient Subtract
    gradienSubtractProgram.bind();
    gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, dx, dy);
    gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write.fbo);
    velocity.swap();
}

function updateDye (dt) {
    gl.viewport(0, 0, dyeWidth, dyeHeight);

    // Advection of Dye
    advectionProgram.bind();
    // Note: Using dye texture resolution for texel size in dye advection
    gl.uniform2f(advectionProgram.uniforms.texelSize, 1.0 / dyeWidth, 1.0 / dyeHeight);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write.fbo);
    dye.swap();

    // Render final dye texture to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    displayMaterial.bind();
    gl.uniform1i(displayMaterial.uniforms.uTexture, dye.read.attach(0));
    blit(null); // Blit to screen (null FBO)
}

function applyInputs () {
    splatStack.forEach(splat => {
        // In this simplified version, we only handle one pointer (mouse)
        if(splat.pointers.length > 0) {
             const pointer = splat.pointers[0];
             if (pointer.moved) {
                splatDensity(pointer.texcoordX, pointer.texcoordY, pointer.deltaX, pointer.deltaY, pointer.color);
                splatVelocity(pointer.texcoordX, pointer.texcoordY, pointer.deltaX, pointer.deltaY);
                pointer.moved = false; // Reset moved flag
             }
        }
    });
    splatStack.length = 0; // Clear stack after processing
}

function splatVelocity (x, y, dx, dy) {
    gl.viewport(0, 0, simWidth, simHeight);
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, 1.0 - y); // Invert Y for texture coords
    // Use scaled mouse delta directly for force
    gl.uniform3f(splatProgram.uniforms.color, dx * config.SPLAT_FORCE, -dy * config.SPLAT_FORCE, 0.0);
    gl.uniform1f(splatProgram.uniforms.radius, config.SPLAT_RADIUS / 100.0);
    blit(velocity.write.fbo);
    velocity.swap();
}

function splatDensity (x, y, dx, dy, color) {
    gl.viewport(0, 0, dyeWidth, dyeHeight);
    splatProgram.bind(); // Re-use splat shader
    gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, 1.0 - y); // Invert Y for texture coords
    // Use DENSITY_INTENSITY and SMOKE_BRIGHTNESS from config
    const baseBrightness = config.SMOKE_BRIGHTNESS;
    gl.uniform3f(splatProgram.uniforms.color, 
        baseBrightness * config.DENSITY_INTENSITY, // Assuming color[0] was just a placeholder for grayscale
        baseBrightness * config.DENSITY_INTENSITY, 
        baseBrightness * config.DENSITY_INTENSITY);
    gl.uniform1f(splatProgram.uniforms.radius, config.SPLAT_RADIUS / 100.0);
    blit(dye.write.fbo);
    dye.swap();
}

// Mouse interaction
canvas.addEventListener('mousemove', (e) => {
    let pointer = pointers[0];
    pointer.moved = true;
    // Use MOUSE_FORCE from config for scaling
    pointer.deltaX = (e.clientX - pointer.texcoordX * canvas.width) * config.MOUSE_FORCE;
    pointer.deltaY = (e.clientY - pointer.texcoordY * canvas.height) * config.MOUSE_FORCE;
    // Update position
    pointer.prevTexcoordX = pointer.texcoordX;
    pointer.prevTexcoordY = pointer.texcoordY;
    pointer.texcoordX = e.clientX / canvas.width;
    pointer.texcoordY = e.clientY / canvas.height;

    // Add splat command to the stack for processing in the update loop
    // Ensures only one splat per frame even with rapid mouse movements
    if (splatStack.length === 0) {
        splatStack.push({ amount: 1, pointers: [pointer] });
    }
});

// Basic touch handling (optional, can be expanded)
canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touches = e.targetTouches;
    if (touches.length > 0) {
        let pointer = pointers[0]; // Use the main pointer for the first touch
        pointer.moved = false; // Reset moved flag on new touch
        pointer.texcoordX = touches[0].pageX / canvas.width;
        pointer.texcoordY = touches[0].pageY / canvas.height;
        pointer.prevTexcoordX = pointer.texcoordX;
        pointer.prevTexcoordY = pointer.texcoordY;
    }
});

canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touches = e.targetTouches;
    if (touches.length > 0) {
        let pointer = pointers[0];
        pointer.moved = true;
        let currentX = touches[0].pageX / canvas.width;
        let currentY = touches[0].pageY / canvas.height;
        pointer.deltaX = (currentX - pointer.texcoordX) * 10.0; // Amplify touch delta
        pointer.deltaY = (currentY - pointer.texcoordY) * 10.0;
        pointer.prevTexcoordX = pointer.texcoordX;
        pointer.prevTexcoordY = pointer.texcoordY;
        pointer.texcoordX = currentX;
        pointer.texcoordY = currentY;

        if (splatStack.length === 0) {
            splatStack.push({ amount: 1, pointers: [pointer] });
        }
    }
}, false);


function hashCode (s) {
    if (s.length == 0) return 0;
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
        hash = (hash << 5) - hash + s.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
};

// GUI Setup
const gui = new dat.GUI({ width: 300 });
gui.add(config, 'DENSITY_DISSIPATION', 0.9, 1.0).name('Density Dissipation');
gui.add(config, 'VELOCITY_DISSIPATION', 0.9, 1.0).name('Velocity Dissipation');
gui.add(config, 'PRESSURE', 0.0, 1.0).name('Pressure');
gui.add(config, 'SPLAT_RADIUS', 0.01, 1.0).name('Splat Radius');
gui.add(config, 'DENSITY_INTENSITY', 0.0, 0.5).name('Density Intensity');
gui.add(config, 'MOUSE_FORCE', 0.0, 10.0).name('Mouse Force');
gui.add(config, 'SMOKE_BRIGHTNESS', 0.0, 1.0).name('Smoke Brightness'); // New slider

// Function to log current config values
function logConfigValues() {
    const relevantConfig = {
        DENSITY_DISSIPATION: config.DENSITY_DISSIPATION,
        VELOCITY_DISSIPATION: config.VELOCITY_DISSIPATION,
        PRESSURE: config.PRESSURE,
        SPLAT_RADIUS: config.SPLAT_RADIUS,
        DENSITY_INTENSITY: config.DENSITY_INTENSITY,
        MOUSE_FORCE: config.MOUSE_FORCE,
        SMOKE_BRIGHTNESS: config.SMOKE_BRIGHTNESS // Added log value
    };
    console.log("Current Config Values:");
    console.log(JSON.stringify(relevantConfig, null, 2));
}

// Add Log Button to GUI
gui.add({ log: logConfigValues }, 'log').name("Log Current Values");

// Reset Function
function resetSimulation() {
    // Reset config values to defaults
    for (const key in defaultConfig) {
        if (config.hasOwnProperty(key)) {
            config[key] = defaultConfig[key];
        }
    }

    // Update GUI controllers
    for (let i in gui.__controllers) {
        gui.__controllers[i].updateDisplay();
    }

    // Clear dye framebuffers
    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, dye.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, 0.0); // Clear to black
    blit(dye.write.fbo);

    gl.uniform1i(clearProgram.uniforms.uTexture, dye.write.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, 0.0);
    blit(dye.read.fbo); // Clear the other buffer too

    // Optional: Clear velocity too if needed
    // gl.uniform1i(clearProgram.uniforms.uTexture, velocity.read.attach(0));
    // gl.uniform1f(clearProgram.uniforms.value, 0.0);
    // blit(velocity.write.fbo);
    // gl.uniform1i(clearProgram.uniforms.uTexture, velocity.write.attach(0));
    // gl.uniform1f(clearProgram.uniforms.value, 0.0);
    // blit(velocity.read.fbo);

    console.log('Simulation and Config Reset to Defaults');
}

gui.add({ reset: resetSimulation }, 'reset').name("Reset Simulation");

// --- Toggle Button Logic ---
const bodyElement = document.body;
const canvasElement = document.getElementById('glcanvas');
const toggleBgBtn = document.getElementById('toggleBgButton');
const toggleCursorBtn = document.getElementById('toggleCursorButton');

if (toggleBgBtn) {
    toggleBgBtn.addEventListener('click', () => {
        bodyElement.classList.toggle('no-background');
        // Update button text
        if (bodyElement.classList.contains('no-background')) {
            toggleBgBtn.textContent = 'Show Background';
        } else {
            toggleBgBtn.textContent = 'Hide Background';
        }
    });
}

if (toggleCursorBtn) {
    toggleCursorBtn.addEventListener('click', () => {
        canvasElement.classList.toggle('default-cursor');
        // Update button text
        if (canvasElement.classList.contains('default-cursor')) {
            toggleCursorBtn.textContent = 'Use Joint Cursor';
        } else {
            toggleCursorBtn.textContent = 'Use Default Cursor';
        }
    });
}

// Initial setup call - already called after blit definition
// initFramebuffers(); // No need to call again here