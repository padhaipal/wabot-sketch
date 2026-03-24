Phase 1 — webhook receiver + OTel:
1.) Import src/otel/otel.ts at the very top of this file, before any other imports (including NestJS). This ensures the OTel SDK registers auto-instrumentations before any HTTP/Express modules are loaded.
2.) Bootstrap NestJS app with rawBody: true.
3.) Listen for incoming requests on process.env.PORT || 3000.

Future phases (not yet implemented):
4.) Start BullMQ workers. Call src/interfaces/redis/queues.ts createWorker() for each queue. Workers run in-process with their processors.