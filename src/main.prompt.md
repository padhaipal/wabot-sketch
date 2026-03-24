MVP (Phase 1 — webhook receiver only):
1.) Bootstrap NestJS app with rawBody: true.
2.) Listen for incoming requests on process.env.PORT || 3000.

Future phases (not yet implemented):
3.) Initialize OTel SDK. See src/otel/otel.prompt.md.
4.) Start BullMQ workers. Call src/interfaces/redis/queues.ts createWorker() for each queue. Workers run in-process with their processors.