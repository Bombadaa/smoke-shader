'use strict';

(function () {

// ============================================================
// CONFIGURATION — Edit these defaults or use data- attributes
// on the container element in Webflow to override them.
//
// In Webflow, add Custom Attributes to the parent div:
//   data-density-dissipation="0.99"
//   data-velocity-dissipation="1"
//   data-pressure="0.9"
//   data-splat-radius="0.4"
//   data-density-intensity="0.012"
//   data-mouse-force="10"
//   data-smoke-brightness="1"
//   data-show-gui="false"
// ============================================================
const DEFAULTS = {
    DENSITY_DISSIPATION: 0.99,
    VELOCITY_DISSIPATION: 1.0,
    PRESSURE: 0.9,
    SPLAT_RADIUS: 0.4,
    DENSITY_INTENSITY: 0.012,
    MOUSE_FORCE: 10.0,
    SMOKE_BRIGHTNESS: 1.0
};

// Find the canvas — supports both Webflow embed and standalone usage
const canvas = document.getElementById('glcanvas');
if (!canvas) return;

// Traverse up the DOM to find the container with data- attributes.
// Webflow wraps Embeds in a .w-embed div, so canvas.parentElement
// won't have the attributes — we need to search upward.
const container = canvas.closest('[data-show-gui]')
    || canvas.closest('[data-density-dissipation]')
    || canvas.parentElement;

// Read data- attributes from container to override defaults
function readDataAttr(name, fallback) {
    if (!container) return fallback;
    const val = container.getAttribute('data-' + name);
    return val !== null ? parseFloat(val) : fallback;
}

const defaultConfig = {
    DENSITY_DISSIPATION: readDataAttr('density-dissipation', DEFAULTS.DENSITY_DISSIPATION),
    VELOCITY_DISSIPATION: readDataAttr('velocity-dissipation', DEFAULTS.VELOCITY_DISSIPATION),
    PRESSURE: readDataAttr('pressure', DEFAULTS.PRESSURE),
    SPLAT_RADIUS: readDataAttr('splat-radius', DEFAULTS.SPLAT_RADIUS),
    DENSITY_INTENSITY: readDataAttr('density-intensity', DEFAULTS.DENSITY_INTENSITY),
    MOUSE_FORCE: readDataAttr('mouse-force', DEFAULTS.MOUSE_FORCE),
    SMOKE_BRIGHTNESS: readDataAttr('smoke-brightness', DEFAULTS.SMOKE_BRIGHTNESS)
};

const showGui = container
    ? (container.getAttribute('data-show-gui') || 'true') !== 'false'
    : true;

// Size canvas to container
canvas.width = canvas.clientWidth;
canvas.height = canvas.clientHeight;

let config = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1024,
    CAPTURE_RESOLUTION: 512,
    DENSITY_DISSIPATION: defaultConfig.DENSITY_DISSIPATION,
    VELOCITY_DISSIPATION: defaultConfig.VELOCITY_DISSIPATION,
    PRESSURE: defaultConfig.PRESSURE,
    PRESSURE_ITERATIONS: 20,
    CURL: 0,
    SPLAT_RADIUS: defaultConfig.SPLAT_RADIUS,
    SPLAT_FORCE: 1.0,
    DENSITY_INTENSITY: defaultConfig.DENSITY_INTENSITY,
    MOUSE_FORCE: defaultConfig.MOUSE_FORCE,
    SMOKE_BRIGHTNESS: defaultConfig.SMOKE_BRIGHTNESS,
    SHADING: false,
    COLORFUL: false,
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
};

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
    this.color = [30, 30, 30];
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

    gl.bindAttribLocation(program, 0, 'aPosition');

    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
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
        console.error(`Shader Compile Error in ${type === gl.VERTEX_SHADER ? 'Vertex' : 'Fragment'} Shader:`, gl.getShaderInfoLog(shader));
        throw gl.getShaderInfoLog(shader);
    }

    return shader;
}

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
        float density = texture2D(uTexture, vUv).r;
        gl_FragColor = vec4(vec3(density), density);
    }
`;

let dye;
let velocity;
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
displayMaterial.setKeywords([]);

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
    };
}

function resizeFBO (target, w, h, internalFormat, format, type, param) {
    let newFBO = createFBO(w, h, internalFormat, format, type, param);
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
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    const positionAttributeLocation = 0;
    gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(positionAttributeLocation);

    const vertices = new Float32Array([
        -1.0, -1.0,
         1.0, -1.0,
        -1.0,  1.0,
         1.0,  1.0,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.disableVertexAttribArray(positionAttributeLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
}

initFramebuffers();

let lastTime = Date.now();

update();

function update () {
    const dt = calcDeltaTime();
    if (resizeCanvas()) initFramebuffers();

    applyInputs();
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

    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, dx, dy);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, velocity.read.attach(0));
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write.fbo);
    velocity.swap();

    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, dx, dy);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence.fbo);

    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
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

    gradienSubtractProgram.bind();
    gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, dx, dy);
    gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write.fbo);
    velocity.swap();
}

function updateDye (dt) {
    gl.viewport(0, 0, dyeWidth, dyeHeight);

    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, 1.0 / dyeWidth, 1.0 / dyeHeight);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write.fbo);
    dye.swap();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    displayMaterial.bind();
    gl.uniform1i(displayMaterial.uniforms.uTexture, dye.read.attach(0));
    blit(null);
}

function applyInputs () {
    splatStack.forEach(splat => {
        if(splat.pointers.length > 0) {
             const pointer = splat.pointers[0];
             if (pointer.moved) {
                splatDensity(pointer.texcoordX, pointer.texcoordY, pointer.deltaX, pointer.deltaY, pointer.color);
                splatVelocity(pointer.texcoordX, pointer.texcoordY, pointer.deltaX, pointer.deltaY);
                pointer.moved = false;
             }
        }
    });
    splatStack.length = 0;
}

function splatVelocity (x, y, dx, dy) {
    gl.viewport(0, 0, simWidth, simHeight);
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, 1.0 - y);
    gl.uniform3f(splatProgram.uniforms.color, dx * config.SPLAT_FORCE, -dy * config.SPLAT_FORCE, 0.0);
    gl.uniform1f(splatProgram.uniforms.radius, config.SPLAT_RADIUS / 100.0);
    blit(velocity.write.fbo);
    velocity.swap();
}

function splatDensity (x, y, dx, dy, color) {
    gl.viewport(0, 0, dyeWidth, dyeHeight);
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, 1.0 - y);
    const baseBrightness = config.SMOKE_BRIGHTNESS;
    gl.uniform3f(splatProgram.uniforms.color,
        baseBrightness * config.DENSITY_INTENSITY,
        baseBrightness * config.DENSITY_INTENSITY,
        baseBrightness * config.DENSITY_INTENSITY);
    gl.uniform1f(splatProgram.uniforms.radius, config.SPLAT_RADIUS / 100.0);
    blit(dye.write.fbo);
    dye.swap();
}

// Helper: get mouse/touch position relative to canvas
function getCanvasRelativePos (clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (clientX - rect.left) / rect.width,
        y: (clientY - rect.top) / rect.height
    };
}

// Mouse interaction — uses getBoundingClientRect for correct position in Webflow
canvas.addEventListener('mousemove', (e) => {
    let pointer = pointers[0];
    const pos = getCanvasRelativePos(e.clientX, e.clientY);

    pointer.moved = true;
    pointer.deltaX = (pos.x - pointer.texcoordX) * canvas.width * config.MOUSE_FORCE;
    pointer.deltaY = (pos.y - pointer.texcoordY) * canvas.height * config.MOUSE_FORCE;
    pointer.prevTexcoordX = pointer.texcoordX;
    pointer.prevTexcoordY = pointer.texcoordY;
    pointer.texcoordX = pos.x;
    pointer.texcoordY = pos.y;

    if (splatStack.length === 0) {
        splatStack.push({ amount: 1, pointers: [pointer] });
    }
});

canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touches = e.targetTouches;
    if (touches.length > 0) {
        let pointer = pointers[0];
        const pos = getCanvasRelativePos(touches[0].clientX, touches[0].clientY);
        pointer.moved = false;
        pointer.texcoordX = pos.x;
        pointer.texcoordY = pos.y;
        pointer.prevTexcoordX = pointer.texcoordX;
        pointer.prevTexcoordY = pointer.texcoordY;
    }
});

canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touches = e.targetTouches;
    if (touches.length > 0) {
        let pointer = pointers[0];
        const pos = getCanvasRelativePos(touches[0].clientX, touches[0].clientY);
        pointer.moved = true;
        pointer.deltaX = (pos.x - pointer.texcoordX) * canvas.width * config.MOUSE_FORCE;
        pointer.deltaY = (pos.y - pointer.texcoordY) * canvas.height * config.MOUSE_FORCE;
        pointer.prevTexcoordX = pointer.texcoordX;
        pointer.prevTexcoordY = pointer.texcoordY;
        pointer.texcoordX = pos.x;
        pointer.texcoordY = pos.y;

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
        hash |= 0;
    }
    return hash;
}

// GUI Setup — only shown when data-show-gui is not "false"
let gui = null;
if (showGui && typeof dat !== 'undefined') {
    gui = new dat.GUI({ width: 300 });
    gui.add(config, 'DENSITY_DISSIPATION', 0.9, 1.0).name('Density Dissipation');
    gui.add(config, 'VELOCITY_DISSIPATION', 0.9, 1.0).name('Velocity Dissipation');
    gui.add(config, 'PRESSURE', 0.0, 1.0).name('Pressure');
    gui.add(config, 'SPLAT_RADIUS', 0.01, 1.0).name('Splat Radius');
    gui.add(config, 'DENSITY_INTENSITY', 0.0, 0.5).name('Density Intensity');
    gui.add(config, 'MOUSE_FORCE', 0.0, 10.0).name('Mouse Force');
    gui.add(config, 'SMOKE_BRIGHTNESS', 0.0, 1.0).name('Smoke Brightness');

    gui.add({ log: function () {
        console.log("Current Config Values:");
        console.log(JSON.stringify({
            DENSITY_DISSIPATION: config.DENSITY_DISSIPATION,
            VELOCITY_DISSIPATION: config.VELOCITY_DISSIPATION,
            PRESSURE: config.PRESSURE,
            SPLAT_RADIUS: config.SPLAT_RADIUS,
            DENSITY_INTENSITY: config.DENSITY_INTENSITY,
            MOUSE_FORCE: config.MOUSE_FORCE,
            SMOKE_BRIGHTNESS: config.SMOKE_BRIGHTNESS
        }, null, 2));
    }}, 'log').name("Log Current Values");

    gui.add({ reset: function () {
        for (const key in defaultConfig) {
            if (config.hasOwnProperty(key)) {
                config[key] = defaultConfig[key];
            }
        }
        for (let i in gui.__controllers) {
            gui.__controllers[i].updateDisplay();
        }
        clearProgram.bind();
        gl.uniform1i(clearProgram.uniforms.uTexture, dye.read.attach(0));
        gl.uniform1f(clearProgram.uniforms.value, 0.0);
        blit(dye.write.fbo);
        gl.uniform1i(clearProgram.uniforms.uTexture, dye.write.attach(0));
        gl.uniform1f(clearProgram.uniforms.value, 0.0);
        blit(dye.read.fbo);
        console.log('Simulation and Config Reset to Defaults');
    }}, 'reset').name("Reset Simulation");
}

})();
