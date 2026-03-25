1.) Start span.
2.) Check data shape against status.dto.ts StatusJobDto.
* If data shape check fails then log ERROR and fail the job.
3.) Log INFO with structured attributes:
  * status.id (the WhatsApp message ID this status refers to)
  * status.status (one of: "sent", "delivered", "read", "failed")
  * status.timestamp
  * status.recipient_id
  These attributes are sent to Grafana via OTel so they are queryable in Grafana dashboards.
4.) Mark the job as complete and end the span.
