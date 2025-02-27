import { performance } from 'node:perf_hooks'
import { createBirpc } from 'birpc'
import { workerId as poolId } from 'tinypool'
import type { CancelReason } from '@vitest/runner'
import type { RunnerRPC, RuntimeRPC, WorkerContext, WorkerGlobalState } from '../types'
import { getWorkerState } from '../utils/global'
import { loadEnvironment } from '../integrations/env'
import { mockMap, moduleCache, startViteNode } from './execute'
import { setupInspect } from './inspector'
import { createSafeRpc, rpcDone } from './rpc'

async function init(ctx: WorkerContext) {
  // @ts-expect-error untyped global
  if (typeof __vitest_worker__ !== 'undefined' && ctx.config.threads && ctx.config.isolate)
    throw new Error(`worker for ${ctx.files.join(',')} already initialized by ${getWorkerState().ctx.files.join(',')}. This is probably an internal bug of Vitest.`)

  const { config, port, workerId } = ctx

  process.env.VITEST_WORKER_ID = String(workerId)
  process.env.VITEST_POOL_ID = String(poolId)

  let setCancel = (_reason: CancelReason) => {}
  const onCancel = new Promise<CancelReason>((resolve) => {
    setCancel = resolve
  })

  const rpc = createSafeRpc(createBirpc<RuntimeRPC, RunnerRPC>(
    {
      onCancel: setCancel,
    },
    {
      eventNames: ['onUserConsoleLog', 'onFinished', 'onCollected', 'onWorkerExit', 'onCancel'],
      post(v) { port.postMessage(v) },
      on(fn) { port.addListener('message', fn) },
    },
  ))

  const environment = await loadEnvironment(ctx.environment.name, {
    root: ctx.config.root,
    fetchModule(id) {
      return rpc.fetch(id, 'ssr')
    },
  })
  if (ctx.environment.transformMode)
    environment.transformMode = ctx.environment.transformMode

  const state: WorkerGlobalState = {
    ctx,
    moduleCache,
    config,
    mockMap,
    onCancel,
    environment,
    durations: {
      environment: 0,
      prepare: performance.now(),
    },
    rpc,
  }

  // @ts-expect-error I know what I am doing :P
  globalThis.__vitest_worker__ = state

  if (ctx.invalidates) {
    ctx.invalidates.forEach((fsPath) => {
      moduleCache.delete(fsPath)
      moduleCache.delete(`mock:${fsPath}`)
    })
  }
  ctx.files.forEach(i => moduleCache.delete(i))

  return state
}

export async function run(ctx: WorkerContext) {
  const inspectorCleanup = setupInspect(ctx.config)

  try {
    const state = await init(ctx)
    const { run, executor } = await startViteNode({ state })
    await run(ctx.files, ctx.config, { environment: state.environment, options: ctx.environment.options }, executor)
    await rpcDone()
  }
  finally {
    inspectorCleanup()
  }
}
