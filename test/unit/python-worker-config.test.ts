import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  pythonIt('enables OCR without force_ocr so searchable PDF text layers survive', () => {
    // _tessdata_path requires bundled pack files; provide a disposable one.
    const tessdata = mkdtempSync(join(tmpdir(), 'dsh-docling-tessdata-'))
    writeFileSync(join(tessdata, 'eng.traineddata'), 'test-pack')
    const script = [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("worker", sys.argv[1])',
      'worker = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(worker)',
      'config, _, _, _, _ = worker._build_config({"output_format": "md", "ocr": True, "table_mode": "fast"})',
      'print(json.dumps({"force_ocr": config.get("force_ocr"), "disable_ocr": config.get("disable_ocr"), "ocr_enabled": config["ocr"]["enabled"]}))'
    ].join('\n')
    try {
      const result = spawnSync(python, ['-c', script, workerPath], {
        encoding: 'utf8',
        env: { ...process.env, DSH_DOCLING_TESSDATA_PATH: tessdata }
      })
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ force_ocr: null, disable_ocr: false, ocr_enabled: true })
    } finally {
      rmSync(tessdata, { recursive: true, force: true })
    }
  })
})
