#!/usr/bin/env node
// kakari CLI のエントリポイント。TypeScript のソースを Node.js の型除去で直接実行する。
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  if (type === 'ExperimentalWarning' && String(warning).includes('Type Stripping')) return;
  return originalEmitWarning.call(process, warning, ...args);
};

const { main } = await import('../src/main.ts');
process.exitCode = await main(process.argv);
