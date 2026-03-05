1.) Start a child span under `wabot.process`. The span name will be `wabot.process.error`.
2.) Classify the error by its `code` field and log with the complete error JSON attached as span metadata:

WARN codes (transient / rate-limit / capacity): 1, 2, 4, 80007, 130429, 130472, 131000, 131016, 131026, 131048, 131049, 131050, 131052, 131056, 131057, 133004, 133008, 133009, 133015, 133016, 134101, 134102, 1752041, 2494100.

ERROR codes (auth / config / permanent failures): 0, 3, 10, 33, 100, 190, 200-299, 368, 130497, 131005, 131008, 131009, 131021, 131031, 131037, 131042, 131045, 131047, 131051, 131053, 131055, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 132068, 132069, 133000, 133005, 133006, 133010, 134011, 134100, 135000, 200006, 200007, 2388001, 2388012, 2388019, 2388040, 2388047, 2388072, 2388073, 2388091, 2388093, 2388103, 2593079, 2593085, 2593107, 2593108.

If the code is not in either list, log a WARN. These are WhatsApp platform error codes, not HTTP status codes. Full reference: https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes

3.) Record a metric increment on `wabot_error_handler_total` with labels `{ code, level }` where level is "warn" or "error".
4.) End the span and terminate the job.
