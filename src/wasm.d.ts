declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}

interface ImportMetaEnv {
  readonly VITE_CD_ARTWORK_EXPORT_FIXTURE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
