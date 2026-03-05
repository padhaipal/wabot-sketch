1.) Use the trace information to start a new span. The span name will be wabot.process, log an INFO.
2.) Route based on job.name
* If job.name is message then run process-message.handler.ts
* If job.name is status then run process-status.handler.ts
* If job.name is error then run process-error.handler.ts
* If job.name is none of the above then log an ERROR and stop the job.