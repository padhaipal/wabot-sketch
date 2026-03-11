1.) Initialize OTel SDK. See src/otel/otel.prompt.md.
2.) Bootstrap NestJS app.
3.) Start BullMQ workers. Call src/redis/queues.ts createWorker() for each queue. Workers run in-process with their processors.
4.) Listen for incoming requests.
