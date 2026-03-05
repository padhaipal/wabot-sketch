1.) Structural validation (parse-whatsapp-webhook.ts step 2). Reject entire payload if any of these fail:
* `object` === "whatsapp_business_account"
* `entry` is array
* every entry has string `id` and array `changes`
* every change has string `field` and non-null object `value`
Does NOT check for messages/statuses/errors arrays -- any combination (including none) is valid.

2.) Per-item validation (wa-message-ingest.processor.ts steps 3.2-3.4). WARN and skip individual items that fail. Other items still get processed.
* message: string `from`, `id`, `timestamp`, `type`
* status: string `id`, `status`, `recipient_id`
* error: number `code`

Full payload shape below.

{
  "object": "whatsapp_business_account", // Structural validation
  "entry": [ // Structural validation
    {
      "id": "<WHATSAPP_BUSINESS_ACCOUNT_ID>", // Structural validation
      "changes": [ // Structural validation
        {
          "field": "messages", // Structural validation. Can be any value but we only initially respond to 'messages'.
          "value": { // Structural validation
            "messaging_product": "whatsapp", // Used in wa-message-ingest.processor.ts step 3.1
            "messages": [ // Optional. Any combination of messages/statuses/errors (including none) is valid.
              {
                "from": "<WHATSAPP_USER_PHONE_NUMBER>", // Per-item validation. Used in process-message.handler.ts
                "id": "<WHATSAPP_MESSAGE_ID>", // Per-item validation. Used to dedupe in process-message.handler.ts
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>", // Per-item validation. Used in process-message.handler.ts step 4.
                "type": "audio" | "text" | "video" | "system" | "unsupported", // Per-item validation. These are the ones I will respond to but I will accept any string here.
                "audio": { // Optional
                  "mime_type": "<MEDIA_ASSET_MIME_TYPE>", // I don't know if I need this
                  "sha256": "<MEDIA_ASSET_SHA256_HASH>", // I don't know if I need this
                  "id": "<MEDIA_ASSET_ID>", // I don't know if I need this
                  "url": "<MEDIA_ASSET_URL>", // I do need this.
                  "voice": <IS_VOICE_RECORDING?> // I don't know if I need this
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
                "system": { // Optional
                  "body": "User <WHATSAPP_USER_PROFILE_NAME> changed from <WHATSAPP_USER_PHONE_NUMBER> to <NEW_WHATSAPP_USER_PHONE_NUMBER>",
                  "wa_id": "<NEW_WHATSAPP_USER_ID>",
                  "type": "user_changed_number"
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
            "statuses": [ // Optional. Any combination of messages/statuses/errors (including none) is valid.
              {
                "id": "<WHATSAPP_MESSAGE_ID>", // Per-item validation
                "status": "<STATUS>", // Per-item validation. Handled values: 'sent', 'read', 'delivered', 'failed'.
                "timestamp": "<WEBHOOK_TRIGGER_TIMESTAMP>",
                "recipient_id": "<USER_PHONE_NUMBER_OR_GROUP_ID>", // Per-item validation. Used in process-status.handler.ts step 2 as wa_id.

                <!-- only included with sent status, and one of either delivered or read status -->
                "pricing": {
                  "billable": <IS_BILLABLE?>,
                  "pricing_model": "<PRICING_MODEL>",
                  "type": "<PRICING_TYPE>",
                  "category": "<PRICING_CATEGORY>"
                },

                <!-- only included if failure to send or deliver message -->
                "errors": [
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
            ],
            "errors": [  // Optional. Any combination of messages/statuses/errors (including none) is valid.
              {
                "code": <ERROR_CODE>, // Per-item validation
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
