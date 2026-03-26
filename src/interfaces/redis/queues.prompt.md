// wabot-sketch/src/interfaces/redis/queues.prompt.md

Export queue names, Redis connection, Queue/Worker factories, and a teardown helper.
Dependencies: `bullmq`, `ioredis`.

1.) QUEUE_NAMES constant (as const object).
* Keys: INGEST, PROCESS_MESSAGE, PROCESS_STATUS, PROCESS_ERRORS, PROCESS_MESSAGE_TIMEOUT.
* Values: 'ingest', 'process-message', 'process-status', 'process-errors', 'process-message-timeout'.

2.) Redis connection (exported).
* Read REDIS_URL from process.env. If missing, throw an Error immediately (fail-fast).
* Read ENV from process.env, default to 'development'.
* Derive prefix: `{wabot:${ENV}}` (cluster hash-tag).
* Create and export an ioredis Redis instance from REDIS_URL with maxRetriesPerRequest: null (required by BullMQ for blocking commands).

3.) Internal tracking.
* Maintain a module-level queues array (Queue[]) and workers array (Worker[]) to track every instance created by the factories below. Used by closeAll().

4.) createQueue(name, defaultJobOptions?) → Queue.
* Returns a BullMQ Queue using the shared connection and prefix.
* Merges caller-supplied defaultJobOptions over sensible defaults: attempts 3, exponential backoff with 1 000 ms initial delay.
* Pushes the queue into the tracking array.
* Used by producers: accept.service (ingest), parse.processor (process-*), message.processor (process-message-timeout).

5.) createWorker(name, processor, opts?) → Worker.
* processor: BullMQ Processor type.
* opts: Omit<WorkerOptions, 'connection' | 'prefix'> — callers may set concurrency, limiter, etc. but connection and prefix are controlled by this module.
* Returns a BullMQ Worker using the shared connection and prefix, spread with caller opts.
* Pushes the worker into the tracking array.
* Workers must be started on app bootstrap (see main.prompt.md).
* Used by: ingest → parse.processor; process-message → message.processor; process-status → status.processor; process-errors → error.processor; process-message-timeout → message.processor.

6.) closeAll() → Promise<void> (exported).
* Close all tracked workers in parallel, then all tracked queues in parallel, then gracefully quit the Redis connection.
* Called by main.ts on SIGTERM/SIGINT (see main.prompt.md).

7.) Worker error handlers.
* Each worker registers 'error' and 'failed' event handlers that log ERROR with the worker name and error message.
