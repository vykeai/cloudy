import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logInfo = vi.fn(async () => {});
const logWarn = vi.fn(async () => {});
let mockedRunDir = '/tmp/project/.cloudy/runs/run-20260314-demo-project';

vi.mock('../../src/utils/logger.js', () => ({
  log: {
    info: logInfo,
    warn: logWarn,
    error: vi.fn(async () => {}),
    debug: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/utils/run-dir.js', () => ({
  getCurrentRunDir: vi.fn(async () => mockedRunDir),
}));

interface CapturedRequest {
  method: string
  url: string
  body: string
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

async function startRecorder(): Promise<{ server: Server; port: number; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = []
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req)
    requests.push({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      body,
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind recorder server')
  }

  return { server, port: address.port, requests }
}

describe('keel integration over HTTP', () => {
  let server: Server | undefined
  let projectDir = '/tmp/project'

  beforeEach(() => {
    vi.clearAllMocks()
    projectDir = ''
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
      server = undefined
    }
  })

  async function prepareRunDir(): Promise<void> {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudy-keel-http-'))
    mockedRunDir = path.join(projectDir, '.cloudy', 'runs', 'run-20260314-demo-project')
    await fs.mkdir(mockedRunDir, { recursive: true })
  }

  it('writes blocked outcomes through the real HTTP path', async () => {
    const recorder = await startRecorder()
    server = recorder.server

    const { writeRunOutcome } = await import('../../src/integrations/keel.js')
    await prepareRunDir()

    await writeRunOutcome(
      { slug: 'demo-project', taskId: 'T-123', port: recorder.port },
      {
        success: false,
        tasksDone: 2,
        tasksFailed: 1,
        topError: 'validator exploded',
        costUsd: 3.21,
        durationMs: 91000,
      },
      projectDir,
    )

    // writeRunOutcome makes two write-backs: a task PATCH and a note POST.
    // (The separate "decision draft" POST was removed in ab4e291.)
    expect(recorder.requests).toHaveLength(2)

    expect(recorder.requests[0]).toMatchObject({
      method: 'PATCH',
      url: '/api/projects/demo-project/tasks/T-123',
    })
    expect(JSON.parse(recorder.requests[0].body)).toEqual({
      status: 'blocked',
      run_status: 'failed',
      cloudy_run: {
        runName: 'run-20260314-demo-project',
        taskId: 'T-123',
      },
    })

    expect(recorder.requests[1]).toMatchObject({
      method: 'POST',
      url: '/api/projects/demo-project/tasks/T-123/notes',
    })
    expect(JSON.parse(recorder.requests[1].body)).toMatchObject({
      by: 'cloudy',
      text: expect.stringContaining('Cloudy run run-20260314-demo-project failed.'),
    })

    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('Updated demo-project/T-123'))
    expect(logWarn).not.toHaveBeenCalled()
  })
})
