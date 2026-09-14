const { commitStore } = require('../src/generation-store');
try {
  const [, , file, generation, marker] = process.argv;
  commitStore(file, { generation: Number(generation), marker });
} catch (error) {
  process.stderr.write(error.code || 'store_write_failed');
  process.exitCode = 1;
}
