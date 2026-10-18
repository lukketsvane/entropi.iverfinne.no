import * as THREE from 'three';
import {PRIMITIVE_BAYER, PRIMITIVE_MODES, normalizePrimitiveLevel, primitiveDimensions} from './primitive-style.ts';

/** Quantize the blended image, rather than the individual transparent splats. */
export class PrimitiveEffect {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    this.level = 0;
    this.disposed = false;
    this.size = new THREE.Vector2();
    this.clearColor = new THREE.Color();
    const floatTarget = renderer.extensions.has('EXT_color_buffer_float');
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      generateMipmaps: false, depthBuffer: true, stencilBuffer: false,
      // Three writes working-linear colour to ordinary render targets. A float
      // buffer avoids an 8-bit linear round trip before the sRGB palette lookup.
      // The core WebGL2 sRGB format provides a display-precision fallback on
      // devices without float attachments; hardware decodes it on sampling.
      type: floatTarget ? THREE.HalfFloatType : THREE.UnsignedByteType,
      colorSpace: floatTarget ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uImage: {value: this.target.texture},
        uSize: {value: new THREE.Vector2(1, 1)},
        uPalette: {value: Array.from({length: 16}, () => new THREE.Vector3())},
        uCount: {value: 0}, uLevel: {value: 0}, uDither: {value: 0}, uOutputLinear: {value: false}
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }',
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uImage;
        uniform vec2 uSize;
        uniform vec3 uPalette[16];
        uniform int uCount;
        uniform int uLevel;
        uniform float uDither;
        uniform bool uOutputLinear;
        float bayer(vec2 pixel) {
          int column = int(mod(pixel.x, 4.));
          int row = int(mod(pixel.y, 4.));
          int index = row * 4 + column;
          ${PRIMITIVE_BAYER.map((value, index) => `if (index == ${index}) return ${value}.;`).join('\n          ')}
          return 0.;
        }
        void main() {
          vec2 pixel = min(floor(vUv * uSize), uSize - 1.);
          vec3 linearColor = texture2D(uImage, (pixel + .5) / uSize).rgb;
          // Convert only here: palettes and their nearest-colour distances are
          // display sRGB. No colorspace_fragment follows the exact palette.
          vec3 color = clamp(sRGBTransferOETF(vec4(max(linearColor, vec3(0.)), 1.)).rgb, 0., 1.);
          vec2 topLeftPixel = vec2(pixel.x, uSize.y - 1. - pixel.y);
          float threshold = (bayer(topLeftPixel) + .5) / 16. - .5;
          if (uLevel == 3) {
            float intensity = clamp(dot(color, vec3(.2126, .7152, .0722)) / (.7152 + .4 * .0722) + threshold * uDither / 255., 0., 1.);
            color = vec3(0., 1., .4) * intensity;
          } else {
            color = clamp(color + threshold * uDither / 255., 0., 1.);
          }
          vec3 closest = uPalette[0];
          float distance = 1.e6;
          for (int i = 0; i < 16; i++) {
            if (i >= uCount) break;
            vec3 difference = color - uPalette[i];
            float next = dot(difference, difference);
            if (next < distance) { closest = uPalette[i]; distance = next; }
          }
          // Ordinary caller-owned render targets store working-linear values.
          // The screen receives exact sRGB bytes, without an additional OETF.
          gl_FragColor = uOutputLinear ? sRGBTransferEOTF(vec4(closest, 1.)) : vec4(closest, 1.);
        }
      `,
      depthTest: false, depthWrite: false, toneMapped: false,
      blending: THREE.NoBlending
    });
    // One oversized triangle has no shared diagonal or interpolation seam.
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.Mesh(this.geometry, this.material));
    this.camera = new THREE.Camera();
  }

  /** @param {number} level */
  setLevel(level) {
    this.level = normalizePrimitiveLevel(level);
    const mode = PRIMITIVE_MODES[this.level];
    this.material.uniforms.uLevel.value = this.level;
    this.material.uniforms.uCount.value = mode.palette.length;
    this.material.uniforms.uDither.value = mode.dither;
    for (let i = 0; i < 16; i++) {
      const color = mode.palette[i] || [0, 0, 0];
      this.material.uniforms.uPalette.value[i].set(color[0] / 255, color[1] / 255, color[2] / 255);
    }
  }

  /** @param {THREE.Scene} scene @param {THREE.Camera} camera */
  render(scene, camera) {
    if (this.disposed) return;
    const renderer = this.renderer;
    if (!this.level) { renderer.render(scene, camera); return; }
    const output = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace();
    const mipLevel = renderer.getActiveMipmapLevel();
    if (output) this.size.set(output.width, output.height);
    else renderer.getDrawingBufferSize(this.size);
    const size = primitiveDimensions(this.level, this.size.x, this.size.y);
    if (this.target.width !== size.width || this.target.height !== size.height) this.target.setSize(size.width, size.height);
    this.material.uniforms.uSize.value.set(size.width, size.height);
    this.material.uniforms.uOutputLinear.value = output !== null;
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    try {
      renderer.setRenderTarget(this.target);
      // Resolve transparency against the same black background before reducing
      // colours; a later alpha blend would introduce colours outside the palette.
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, true, true);
      renderer.autoClear = false;
      renderer.render(scene, camera);
      renderer.setRenderTarget(output, cubeFace, mipLevel);
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(output, cubeFace, mipLevel);
      renderer.setClearColor(this.clearColor, clearAlpha);
      renderer.autoClear = autoClear;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry.dispose(); this.material.dispose(); this.target.dispose();
  }
}
