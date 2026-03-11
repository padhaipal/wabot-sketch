sendReadAndTypingIndicator()
sendMessage()
* Before I attempt to send any message there needs to be a check to see if a key containing that user_id exists in the inflight redis namespace. If so then remove the user_id and send the message. If not then block this message from being sent and return 
When the worker activates it will run `DEL "{wabot:${ENV}}:inflight:<user_id>"` if the key exists then it 

This method needs to handle a flag that lets it send the message even if `DEL "{wabot:${ENV}}:inflight:<user_id>"` doesn't delete anything. This is because I send the fall back message when redis is unresponsive to set the key in the first place so it won't be in there to delete. 

I need to hand the case when redis is non-responsive. If the message is the fall back message I will probably just send it. If the message is anything else then I will probably just block it. 

outbound.service.ts/sendMessage()

sendMessage(user_id, wamid, consecutive-flag, message formatting)
* If the message is flagged as responding to a consecutive message then it is sent and the https response status is returned.
* Otherwise it attempts the following two commands atomically with a Lua command
  `DEL “{wabot:${ENV}}:inflight:user-id:<user_id>:wamid:<wamid>”` and 
  `DEL “{wabot:${ENV}}:consecutive-check:user-id:<user_id>”`
	* if the Lua command succeeds (ie both DEL commands return 1) then it will send the message to WhatsApp.
    * if WhatsApp returns 2XX then log INFO and return that status. 
    * if WhatsApp returns 4XX then log ERROR and return that status.
    * if WhatsApp returns 5XX then log WARN then exponential fallback with a max time cap of 5s.
      * if max time cap is reached then log an ERROR and return the 5XX status
	* if the Lua command fails (ie both DEL commands return 0) then an INFO is logged and the function returns. 
