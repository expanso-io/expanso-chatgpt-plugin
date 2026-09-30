// Node stand-in for the Workers runtime module, used only by tests.
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected readonly ctx: ExecutionContext,
    protected readonly env: Env,
  ) {}
}
