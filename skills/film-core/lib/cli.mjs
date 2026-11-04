// film-core lib · Agent 工具共用的命令行守卫：--help / -h 打印参数表后 exit 0（在任何副作用之前），
// 未知参数 / 缺值 / 多余的位置参数 → stderr 说清 + exit 2。
//
// 用法（脚本第一行可执行代码就调它，早于建目录、起浏览器、读片子）：
//   import { cli } from '../../film-core/lib/cli.mjs';
//   cli({
//     usage: 'node physcheck.mjs --film <slug> [选项]',
//     about: '一句话说明',
//     opts: {
//       film: ['<slug>', '片子'],            // 数组 = 带值参数：[元变量, 说明]
//       json: '输出 JSON',                   // 字符串 = 开关参数
//     },
//     positional: '<文件...>',              // 可选：允许位置参数，并在用法里说明；不给 = 不允许
//     maxPositional: 1,                     // 可选：位置参数个数上限
//     notes: '多行补充说明（可选）',
//   });
// 只做校验与帮助，不改变各脚本原有的取值方式（flag()/has()/indexOf 都照旧工作）。
// 不支持 --key=value 写法（各脚本的取值函数都不认它，放行会被静默忽略），遇到会直接报错。

export const FILM_OPTS = Object.freeze({
  film: ['<slug>', '片子（films/<slug>/）；只有一部时可省略'],
  'films-dir': ['<dir>', 'films/ 目录；不给时依次查 $FILMS_DIR、从 cwd 往上找含 films/ 的目录'],
});

function helpText(spec) {
  const lines = [];
  if (spec.usage) lines.push(`用法：${spec.usage}`);
  if (spec.about) lines.push('', spec.about);
  const entries = Object.entries(spec.opts ?? {});
  if (entries.length || spec.positional) {
    lines.push('', '参数：');
    const rows = entries.map(([k, v]) => [`--${k}${Array.isArray(v) ? ' ' + v[0] : ''}`, Array.isArray(v) ? v[1] : v]);
    if (spec.positional) rows.unshift([spec.positional, spec.positionalHelp ?? '位置参数']);
    rows.push(['-h, --help', '打印本帮助后退出（不做任何事）']);
    const w = Math.min(28, Math.max(...rows.map((r) => r[0].length)));
    for (const [a, b] of rows) lines.push(`  ${a.padEnd(w)}  ${b ?? ''}`);
  }
  if (spec.notes) lines.push('', spec.notes.replace(/\n+$/, ''));
  return lines.join('\n') + '\n';
}

/** 校验 argv；--help 时打印并 exit 0。返回 { positionals }。 */
export function cli(spec, argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(helpText(spec));
    process.exit(0);
  }
  const opts = spec.opts ?? {};
  const bad = (msg) => {
    process.stderr.write(`✗ ${msg}\n  用 --help 查看参数表\n`);
    process.exit(2);
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (name.includes('=')) bad(`不支持 ${a} 写法，用 --${name.split('=')[0]} <值>`);
      if (!(name in opts)) bad(`未知参数 ${a}`);
      if (Array.isArray(opts[name])) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) bad(`${a} 需要一个值 ${opts[name][0]}`);
        i++;
      }
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d|^-\./.test(a)) {
      bad(`未知参数 ${a}`);
    } else {
      if (!spec.positional) bad(`多余的参数 ${JSON.stringify(a)}（本脚本不收位置参数）`);
      positionals.push(a);
    }
  }
  if (spec.maxPositional != null && positionals.length > spec.maxPositional) {
    bad(`多余的参数 ${positionals.slice(spec.maxPositional).map((x) => JSON.stringify(x)).join(' ')}（最多 ${spec.maxPositional} 个位置参数）`);
  }
  return { positionals };
}
