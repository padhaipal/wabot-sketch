sendMessage()
PP_INTERNAL_BASE_URL is available in .env
Required data structure is in pp-sketch/src/interfaces/wabot/inbound/wabot-inbound.dto.prompt.md
  * if pp returns 2XX then log INFO and return that status.
  * if pp returns 4XX then log ERROR and return that status.
  * if pp returns 5XX then log ERROR and return that status. (Note that I am currently not supporting retries for pp.)
