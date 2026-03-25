1.) Start span.
2.) Check data shape against error.dto.ts ErrorJobDto.
* If data shape check fails then log ERROR and fail the job.
3.) Log WARN with structured attributes:
  * error.code
  * error.title
  * error.message
  * error.error_data.details
  * error.href
  These attributes are sent to Grafana via OTel so they are queryable in Grafana dashboards.
4.) Mark the job as complete and end the span.
