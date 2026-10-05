/// <reference types="vite/client" />

// GLSL snippets are imported as raw strings: `import noise from './glsl/noise.glsl?raw'`.
declare module '*.glsl?raw' {
  const src: string;
  export default src;
}
