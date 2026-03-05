1.) Check that the json payload has the minimum critical shape which is described below.

{
  "object": "whatsapp_business_account", // Used in pares-whatsapp-webhook.ts
  "entry": [ // Optional. Used in wa-handle-ingest.processor.ts
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>", // used in wa-handle-ingest.processor.ts
      "changes": [ // Optional. Used in wa-handle-ingest.processor.ts
        {
          "field": "messages", // Can be any value but I will only initially respond to the value of 'messages'. Used in wa-handle-ingest.processor.ts
          "value": { // Optional
            "messaging_product": "whatsapp", // Used in pares-whatsapp-webhook.ts
            "messages": [ // Optional
              {
                "from": "<WHATSAPP_USER_PHONE_NUMBER>", // Used in process-message.handler.ts 
                "id": "<WHATSAPP_MESSAGE_ID>", // Used to dedupe in process-message.handler.ts
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>", // Used in process-message.handler.ts step 4. 
                "type": "audio" | "text" | "video" | "system" | "unsupported", // These are the ones I will respond to but I will accept any string here.
                "audio": { // Optional
                  "mime_type": "<MEDIA_ASSET_MIME_TYPE>", // I don't know if I need this
                  "sha256": "<MEDIA_ASSET_SHA256_HASH>", // I don't know if I need this
                  "id": "<MEDIA_ASSET_ID>", // I don't know if I need this
                  "url": "<MEDIA_ASSET_URL>", // I do need this. 
                  "voice": <IS_VOICE_RECORDING?> // I don't know if I need this
                },
                "text": { // Optional. Obviously you wouldn't get multiple types in one message as is shown here. 
                  "body": "<MESSAGE_TEXT_BODY>"
                },
                "video": { // Optional.
                  "caption": "<MEDIA_ASSET_CAPTION>",
                  "mime_type": "<MEDIA_ASSET_MIME_TYPE>",
                  "sha256": "<MEDIA_ASSET_SHA256_HASH>",
                  "id": "<MEDIA_ASSET_ID>",
                  "url": "<MEDIA_ASSET_URL>"
                },
                "system": { // Optional
                  "body": "User <WHATSAPP_USER_PROFILE_NAME> changed from <WHATSAPP_USER_PHONE_NUMBER> to <NEW_WHATSAPP_USER_PHONE_NUMBER>",
                  "wa_id": "<NEW_WHATSAPP_USER_ID>",
                  "type": "user_changed_number"
                },
                "errors": [ // Optional key
                  {
                    "code": 131051, // I don't know if I need this
                    "title": "Message type unknown", // I don't know if I need this
                    "message": "Message type unknown", // I don't know if I need this
                    "error_data": { // I don't know if I need this
                      "details": "Message type is currently not supported." // I don't know if I need this
                    }
                  }
                ],
              }
            ],
            "statuses": [ // Optional
              {
                "id": "<WHATSAPP_MESSAGE_ID>",
                "status": "<STATUS>", // This is used in process-status.handler.ts steps 1, 2 and 3 handled values include 'sent', 'read', 'delivered' and 'failed'. 
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "recipient_id": "<USER_PHONE_NUMBER_OR_GROUP_ID>", // This is used in process-status.handler.ts step 2 but I call it wa_id there. 
                     
                <!-- only included with sent status, and one of either delivered or read status -->
                "pricing": {
                  "billable": <IS_BILLABLE?>,
                  "pricing_model": "<PRICING_MODEL>",
                  "type": "<PRICING_TYPE>",
                  "category": "<PRICING_CATEGORY>"
                },
                      
                <!-- only included if failure to send or deliver message -->
                "errors": [
                  {
                    "code": <ERROR_CODE>,
                    "title": "<ERROR_TITLE>",
                    "message": "<ERROR_MESSAGE>",
                    "error_data": {
                      "details": "<ERROR_DETAILS>"
                    },
                    "href": "<ERROR_CODES_URL>"
                  }
                ]
              }
            ],
            "errors": [  // Optional
              {
                "code": <ERROR_CODE>,
                "title": "<ERROR_TITLE>",
                "message": "<ERROR_MESSAGE>",
                "error_data": {
                  "details": "<ERROR_DETAILS>"
                },
                "href": "<ERROR_CODES_URL>"
              }
            ]
          }
        }
      ]
    }
  ]
}
