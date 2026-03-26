1.) Import src/otel/otel.ts at the very top of this file, before any other imports (including NestJS). This ensures the OTel SDK registers auto-instrumentations before any HTTP/Express modules are loaded.
2.) Import closeAll from src/interfaces/redis/queues.ts (use .js extension for nodenext module resolution). This eagerly initialises the Redis connection on startup.
3.) Define an async bootstrap() function:
  a.) Create the NestJS app with rawBody: true and logger: new OtelLogger() (see otel/otel-logger.prompt.md). This bridges all NestJS Logger output to OTel so logs reach Grafana Cloud Loki.
  b.) Register a graceful shutdown handler: define an async shutdown(signal) function that calls closeAll() (drains BullMQ workers/queues and quits Redis) then calls app.close(). Attach it to process SIGTERM and SIGINT via process.on(), using void to discard the promise.
  c.) Listen for incoming requests on process.env.PORT || 3000.
4.) Call bootstrap(). Catch any error, log it with console.error, and set process.exitCode = 1.

Future phases (not yet implemented):
5.) Start BullMQ workers. Call src/interfaces/redis/queues.ts createWorker() for each queue between steps 3a and 3b. Workers run in-process with their processors.