// Stylesheets are bundled by esbuild, and SVG files come in as their text (scripts/build.mjs).
declare module '*.css';
declare module '*.svg' {
  const text: string;
  export default text;
}
