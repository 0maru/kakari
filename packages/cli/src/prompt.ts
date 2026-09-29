import { createInterface } from 'node:readline';

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

/** 入力をマスクして読む（16.3: パスワードをコマンドライン引数へ渡さない） */
export async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // パイプからの入力（1行）
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').split('\n')[0] ?? '';
  }
  process.stderr.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          stdin.off('data', onData);
          reject(new Error('cancelled'));
          return;
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

export async function confirm(question: string): Promise<boolean> {
  const answer = (await ask(`${question} [y/N] `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}
