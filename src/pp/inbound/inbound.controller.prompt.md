sendMessage()
// todo: describe the dto which will be controlled by wabot-sketch/src/whatsapp/outbound/outbound.dto.ts which in turn is controlled by whatsapp documentation.
1.) Check the http message data structure against inbound.dto.ts. 
* If the check fails then return a 400 response.
2.) Use the message payload to start a span.
3.) Call src/whatsapp/outbound/outbound.service.ts/sendMessage().
4.) Return to pp whatever sendMessage() returns and end the span. 

downloadMedia()
1.) Check the http request body against src/pp/inbound/inbound.dto.ts DownloadMediaDto.
* If the check fails then return a 400 response.
2.) Extract the OTel carrier from the request body and start a span.
3.) Call src/whatsapp/outbound/outbound.service.ts/downloadMedia(body.media_url).
4.) Set the response content-type header to the returned content_type. Pipe the returned readable stream directly into the HTTP response body.
5.) End the span when the stream finishes.
* If downloadMedia() throws or the stream errors: log WARN, end the span and return 502.
