/** Small monochrome optical viewfinder; the original camera frames stay unfiltered. */
export class Viewfinder {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas; this.active = true; this.disposed = false;
    /** @type {HTMLVideoElement|HTMLCanvasElement|null} */ this.source = null;
    canvas.width = 240; canvas.height = 360;
    this.gl = canvas.getContext('webgl', {alpha:false,antialias:false,powerPreference:'low-power',preserveDrawingBuffer:false});
    this.fallback = this.gl ? null : canvas.getContext('2d');
    const gl = this.gl;
    if (gl) {
      /** @param {number} type @param {string} code */
      const shader = (type, code) => {
        const result = gl.createShader(type);
        if (!result) throw new Error('Kameraet kunne ikkje visast.');
        gl.shaderSource(result,code); gl.compileShader(result);
        if (!gl.getShaderParameter(result,gl.COMPILE_STATUS)) { gl.deleteShader(result); throw new Error('Kameraet kunne ikkje visast.'); }
        return result;
      };
      const vertex = shader(gl.VERTEX_SHADER, 'attribute vec2 p; varying vec2 uv; void main(){uv=p*.5+.5;gl_Position=vec4(p,0.,1.);}');
      const fragment = shader(gl.FRAGMENT_SHADER, `precision mediump float;
        uniform sampler2D image; uniform vec2 crop; uniform float time;
        varying vec2 uv;
        void main(){
          vec2 q=uv*2.-1.; float r=dot(q,q);
          vec2 warped=q*(1.+.28*r);
          vec2 at=warped*.5+.5;
          if(at.x<0.||at.y<0.||at.x>1.||at.y>1.){gl_FragColor=vec4(0.,0.,0.,1.);return;}
          vec3 rgb=texture2D(image,(at-.5)*crop+.5).rgb;
          float gray=dot(rgb,vec3(.299,.587,.114));
          gray=clamp((gray-.07)*1.2,0.,1.);
          float grain=fract(sin(dot(gl_FragCoord.xy+floor(time*18.),vec2(12.9898,78.233)))*43758.5453)-.5;
          gray=gray*(1.-.36*r)*( .95+.05*sin(gl_FragCoord.y*3.14159))+grain*.026;
          gl_FragColor=vec4(vec3(max(0.,gray)),1.);
        }`);
      const program=gl.createProgram();
      if (!program) throw new Error('Kameraet kunne ikkje visast.');
      gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
      gl.deleteShader(vertex);gl.deleteShader(fragment);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('Kameraet kunne ikkje visast.');
      this.program=program;gl.useProgram(program);
      this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
      const position=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
      this.texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,this.texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
      this.crop=gl.getUniformLocation(program,'crop');this.time=gl.getUniformLocation(program,'time');
    }
    this.animation=0; let previous=0;
    /** @param {number} time */
    const frame=time=>{
      if(this.disposed)return;
      this.animation=requestAnimationFrame(frame);
      if(!this.active||document.hidden||time-previous<50)return;
      previous=time;this.draw(time);
    };
    this.animation=requestAnimationFrame(frame);
  }
  /** @param {number} time */
  draw(time) {
    const source=this.source;
    if(!source)return;
    const video=source instanceof HTMLVideoElement;
    if(video&&source.readyState<2)return;
    const width=video?source.videoWidth:source.width, height=video?source.videoHeight:source.height;
    if(!width||!height)return;
    const gl=this.gl;
    if(gl&&!gl.isContextLost()) {
      try {
        gl.bindTexture(gl.TEXTURE_2D,this.texture ?? null);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,source);
        const ratio=width/height/(this.canvas.width/this.canvas.height);
        gl.uniform2f(this.crop ?? null,Math.min(1,1/ratio),Math.min(1,ratio));gl.uniform1f(this.time ?? null,time/1000);
        gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      } catch { /* A camera frame can briefly disappear when iOS backgrounds the app. */ }
    } else if(this.fallback) {
      this.fallback.filter='grayscale(1) contrast(1.2)';
      this.fallback.drawImage(source,0,0,this.canvas.width,this.canvas.height);
    }
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.animation);
    this.gl?.deleteTexture(this.texture ?? null);this.gl?.deleteBuffer(this.buffer ?? null);this.gl?.deleteProgram(this.program ?? null);
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();this.source=null;
  }
}
