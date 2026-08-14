import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const workerPath = fileURLToPath(new URL('../../python/worker.py', import.meta.url))
const python = process.env.DSH_DOC_TEST_PYTHON ?? process.env.PYTHON ?? 'python'
const pythonAvailable = spawnSync(python, ['--version'], { encoding: 'utf8' }).status === 0
const pythonIt = pythonAvailable ? it : it.skip

describe('embedded Python worker configuration', () => {
  pythonIt('maps fast and accurate table modes to the same PDF options as the Node engine', () => {
    const script = [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("worker", sys.argv[1])',
      'worker = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(worker)',
      'def options(mode):',
      '    config, _, _, _, _ = worker._build_config({"output_format": "md", "ocr": False, "table_mode": mode})',
      '    return config["pdf_options"]',
      'print(json.dumps({"fast": options("fast"), "accurate": options("accurate")}))'
    ].join('\n')
    const result = spawnSync(python, ['-c', script, workerPath], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      fast: { extract_tables: false, reading_order: false },
      accurate: { extract_tables: true, reading_order: true }
    })
  })
})
