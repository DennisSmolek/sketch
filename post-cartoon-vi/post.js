import {
  Color,
  DoubleSide,
  MeshNormalMaterial,
  RawShaderMaterial,
} from "../third_party/three.module.js";
import { ShaderPass } from "../js/ShaderPass.js";
import { getFBO } from "../js/FBO.js";
import { shader as orthoVs } from "../shaders/ortho-vs.js";
import { shader as sobel } from "../shaders/sobel.js";
import { shader as aastep } from "../shaders/aastep.js";
import { shader as luma } from "../shaders/luma.js";
import { generateParams as generatePaperParams } from "../js/paper.js";
import { shader as darken } from "../shaders/blend-darken.js";
import { shader as screen } from "../shaders/blend-screen.js";

const normalMat = new MeshNormalMaterial({ side: DoubleSide });

const fragmentShader = `#version 300 es
precision highp float;

uniform sampler2D colorTexture;
uniform sampler2D normalTexture;
uniform sampler2D paperTexture;
uniform vec3 inkColor;
uniform float scale;
uniform float levels;
uniform float thickness;
uniform float contour;
uniform float minLuma;
uniform float maxLuma;
uniform float light;

out vec4 fragColor;

in vec2 vUv;

${sobel}

${luma}

${aastep}

${darken}
${screen}

#define mul(a,b) (b*a)

float lines( in float l, in vec2 uv, in vec2 resolution, in float thickness){
  vec2 center = .5 * resolution;
  uv *= resolution;
  float c = .5 + .5 * sin(uv.x*.5);
  float f = (c+thickness)*l;
  float e = 1. * length(vec2(dFdx(uv.x), dFdy(uv.y))); 
  f = smoothstep(.5-e, .5+e, f);
  return f;
}

#define TAU 6.28318530718

vec2 rot(in vec2 uv, in float a) {
  a = a * TAU / 360.;
  float s = sin(a);
  float c = cos(a);
  mat2 rot = mat2(c, -s, s, c);
  return rot * uv;
}

void main() {
  vec2 size = vec2(textureSize(colorTexture, 0));
  float e = .01;
  vec4 color = texture(colorTexture, vUv);
  float normalEdge = 1.- length(sobel(normalTexture, vUv, size, contour));
  normalEdge = smoothstep(.5-thickness, .5+thickness, normalEdge);
  vec4 paper = texture(paperTexture, .00025 * vUv*size);
  
  float l0 = luma(color.rgb);
  float l = smoothstep(minLuma, maxLuma, l0);

  float shadeCol = round(l * levels) / levels;

  shadeCol *= normalEdge;

  vec3 rgbscreen = mix(vec3(1.), inkColor/255., 1.-shadeCol);

  vec3 dots = vec3(0.);
  if(l0>(1.-light)){
    vec2 uv = vUv * size;
    float frequency = .05;

    // adapted from https://github.com/libretro/glsl-shaders/blob/master/misc/cmyk-halftone-dot.glsl

    float w = mix(0., 1., thickness);
    mat2 k_matrix = mat2(0.707, 0.707, -0.707, 0.707);
    vec2 Kst = frequency * scale * mul(k_matrix , uv);
    vec2 Kuv = w * (2. * fract(Kst) - 1.);
    float k = step(0.0, sqrt(l0-(1.-light)) - length(Kuv));
    
    dots = vec3(k);
  }

  fragColor.rgb = blendDarken(paper.rgb, rgbscreen, 1.);
  fragColor.rgb = blendScreen(fragColor.rgb, dots, 1.);
  fragColor.a = 1.;
}
`;

const finalFragmentShader = `#version 300 es
precision highp float;

uniform sampler2D colorTexture;
uniform float delta;

in vec2 vUv;

out vec4 fragColor;

${luma}

void main() {
  vec2 dir = vUv - vec2( .5 );
	float d = .7 * length( dir );
  normalize( dir );
	vec2 value = d * dir * delta;
  vec2 resolution = vec2(textureSize(colorTexture, 0));

	vec4 c1 = texture(colorTexture, vUv - value / resolution.x );
	vec4 c2 = texture(colorTexture, vUv );
	vec4 c3 = texture(colorTexture, vUv + value / resolution.y );
	float c = luma(vec3(c1.r,c2.g,c3.b));
  fragColor = vec4(c,c,c, 1.);
}
`;

class Post {
  constructor(renderer) {
    this.renderer = renderer;
    this.colorFBO = getFBO(1, 1);
    this.normalFBO = getFBO(1, 1);
    this.params = {
      scale: 1.5,
      thickness: 1,
      contour: 4,
      inkColor: new Color(13, 13, 13),
      min: 0.3,
      max: 1,
      light: 0.38,
      aberration: 20,
      levels: 100,
    };
    const shader = new RawShaderMaterial({
      uniforms: {
        paperTexture: { value: null },
        colorTexture: { value: this.colorFBO.texture },
        normalTexture: { value: this.normalFBO.texture },
        inkColor: { value: this.params.inkColor },
        scale: { value: this.params.scale },
        thickness: { value: this.params.thickness },
        contour: { value: this.params.contour },
        minLuma: { value: this.params.min },
        maxLuma: { value: this.params.max },
        light: { value: this.params.light },
        levels: { value: this.params.levels },
      },
      vertexShader: orthoVs,
      fragmentShader,
    });
    const finalShader = new RawShaderMaterial({
      uniforms: {
        colorTexture: { value: null },
        delta: { value: this.params.aberration },
      },
      vertexShader: orthoVs,
      fragmentShader: finalFragmentShader,
    });
    this.renderPass = new ShaderPass(renderer, shader);
    this.finalPass = new ShaderPass(renderer, finalShader);
    finalShader.uniforms.colorTexture.value = this.renderPass.fbo.texture;
  }

  setSize(w, h) {
    this.normalFBO.setSize(w, h);
    this.colorFBO.setSize(w, h);
    this.renderPass.setSize(w, h);
    this.finalPass.setSize(w, h);
  }

  render(scene, camera) {
    this.renderer.setRenderTarget(this.colorFBO);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    scene.overrideMaterial = normalMat;
    this.renderer.setRenderTarget(this.normalFBO);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    scene.overrideMaterial = null;
    this.renderPass.render(true);
    //this.finalPass.render(true);
  }

  generateParams(gui) {
    const controllers = {};
    controllers["levels"] = gui
      .add(this.params, "levels", 1, 100)
      .onChange(async (v) => {
        this.renderPass.shader.uniforms.levels.value = v;
      });
    controllers["scale"] = gui
      .add(this.params, "scale", 0.1, 2)
      .onChange(async (v) => {
        this.renderPass.shader.uniforms.scale.value = v;
      });
    controllers["thickness"] = gui
      .add(this.params, "thickness", 0.0, 3)
      .onChange(async (v) => {
        this.renderPass.shader.uniforms.thickness.value = v;
      });
    controllers["contour"] = gui
      .add(this.params, "contour", 0.0, 10)
      .onChange(async (v) => {
        this.renderPass.shader.uniforms.contour.value = v;
      });
    controllers["min"] = gui
      .add(this.params, "min", 0.0, 1, 0.01)
      .onChange(async (v) => {
        this.renderPass.shader.uniforms.minLuma.value = v;
      });
    controllers["max"] = gui
      .add(this.params, "max", 0.0, 1, 0.01)
      .onChange(async (v) => {
        this.renderPass.shader.uniforms.maxLuma.value = v;
      });
    controllers["light"] = gui
      .add(this.params, "light", 0.0, 1, 0.01)
      .onChange(async (v) => {
        this.renderPass.shader.uniforms.light.value = v;
      });
    controllers["aberration"] = gui
      .add(this.params, "aberration", 0.0, 100, 0.1)
      .onChange(async (v) => {
        this.finalPass.shader.uniforms.delta.value = v;
      });
    controllers["inkColor"] = gui
      .addColor(this.params, "inkColor")
      .onChange(async (v) => {
        this.renderPass.shader.uniforms.inkColor.value.copy(v);
      });
    controllers["paper"] = generatePaperParams(gui, this.renderPass.shader);
    return controllers;
  }
}

export { Post };
