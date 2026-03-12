sendMessage()
1.) Check the http message data structure against inbound.dto.ts. 
* If the check fails then return a 400 response.
2.) Use the message payload to start a span.
3.) Call src/whatsapp/outbound/outbound.service.ts/sendMessage().
4.) Return to pp whatever sendMessage() returns and end the span. 
