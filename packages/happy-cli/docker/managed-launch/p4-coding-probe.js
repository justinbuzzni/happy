// 실제 코딩 작업 한 벌: 파일 쓰기 → 읽기 → 테스트 명령 실행 → 결과 확인.
const tool = (suffix) => Object.keys(tools).find((n) => n.endsWith(suffix));
const call = async (label, suffix, args) => {
  try { text(label + '=' + JSON.stringify(await tools[tool(suffix)](args)).slice(0, 400)); }
  catch (error) { text(label + '=ERR:' + String(error && error.message ? error.message : error).slice(0, 200)); }
};
text('TOOLS:' + JSON.stringify(Object.keys(tools).filter((n) => n.indexOf('saycode') >= 0).sort()));
await call('WRITE_SRC', 'write_file', {
  path: 'src/add.js',
  contents: 'module.exports = (a, b) => a + b;\n',
});
await call('WRITE_TEST', 'write_file', {
  path: 'src/add.test.js',
  contents: [
    'const add = require("./add");',
    'if (add(2, 3) !== 5) { console.error("FAIL"); process.exit(1); }',
    'console.log("SUM-OK", add(2, 3));',
  ].join('\n') + '\n',
});
await call('LIST', 'list_files', { path: 'src' });
await call('READ_BACK', 'read_file', { path: 'src/add.js' });
await call('RUN_TEST', 'run_command', { command: 'node', args: ['src/add.test.js'] });
await call('RUN_FAILING', 'run_command', { command: 'node', args: ['-e', 'process.exit(3)'] });
await call('ESCAPE', 'read_file', { path: '../../etc/passwd' });
await call('SHELL_INJECTION', 'run_command', { command: 'sh -c "id"', args: [] });
