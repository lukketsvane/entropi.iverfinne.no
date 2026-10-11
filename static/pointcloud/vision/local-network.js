/* Self-hosted inference assets only. No camera uploads or remote metrics. */
(() => {
  const origin=self.location.origin;
  const paths=new Set([
    '/pointcloud/vision/tasks-vision.js',
    '/pointcloud/vision/blaze-face-short-range.tflite',
    '/pointcloud/vision/wasm/vision_wasm_internal.js',
    '/pointcloud/vision/wasm/vision_wasm_internal.wasm',
    '/pointcloud/vision/wasm/vision_wasm_nosimd_internal.js',
    '/pointcloud/vision/wasm/vision_wasm_nosimd_internal.wasm',
  ]);
  function allowed(input,method='GET') {
    const url=new URL(input instanceof Request ? input.url : String(input),origin);
    return url.origin===origin&&paths.has(url.pathname)&&!url.search&&['GET','HEAD'].includes(method.toUpperCase());
  }
  const fetchAsset=self.fetch.bind(self);
  self.fetch=(input,options)=>{
    const method=options?.method??(input instanceof Request ? input.method : 'GET');
    if(!allowed(input,method))return Promise.reject(new TypeError('Only local vision assets are permitted.'));
    return fetchAsset(input,{...options,redirect:'error'});
  };
  const open=self.XMLHttpRequest.prototype.open;
  self.XMLHttpRequest.prototype.open=function(method,url,...options){
    if(!allowed(url,method))throw new TypeError('Only local vision assets are permitted.');
    return open.call(this,method,url,...options);
  };
  const importAssets=self.importScripts.bind(self);
  self.importScripts=(...urls)=>{
    if(!urls.every(url=>allowed(url)))throw new TypeError('Only local vision assets are permitted.');
    importAssets(...urls);
  };
})();
