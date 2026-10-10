// `import text from './file.js?text'` (see the text-files plugin in scripts/build.mjs).
declare module '*?text' {
  const text: string;
  export default text;
}
