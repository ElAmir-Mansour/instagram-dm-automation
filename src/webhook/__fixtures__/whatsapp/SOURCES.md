# WhatsApp webhook fixtures: sources

Every `*.json` here is a payload copied from Meta's official WhatsApp Business Platform docs, retrieved 2026-10-19 from the raw-markdown version of each page (page URL + `.md`). The code blocks are HTML-entity-escaped in that rendering; the only transformation applied is decoding those entities (`&quot;` -> `"`, `&#123;` -> `{`, ...). Key order, spacing and values (including the docs' own oddities, such as the malformed `wamid` in `text-group.json` and the one-space indent in the `bsuid-*` files) are kept exactly as published. JSON has no comments, so provenance lives here.

Pinned by `src/webhook/whatsapp.test.ts`, which runs every file in this folder. Do not edit a fixture to make a test pass: if Meta changes a shape, re-fetch the page and replace the file.

| File | Source page | What it is |
| --- | --- | --- |
| `text-message.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text> | Text message (sample "Text message") |
| `text-message-business-button.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text> | Text sent with the catalog "Message business" button (context.referred_product) |
| `text-ctwa-referral.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text> | Text sent via a Click to WhatsApp ad: messages[].referral with ctwa_clid |
| `text-group.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/group> | Text sent in a group (messages[].group_id) |
| `interactive-list-reply.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/interactive> | Interactive list reply |
| `interactive-button-reply.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/interactive> | Interactive reply button |
| `interactive-product.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/interactive> | Single-product message sent from a catalog (interactive.type = product) |
| `button-template-reply.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/button> | Template quick-reply button tapped (type = button) |
| `audio-voice.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/audio> | Voice note (audio.voice = true) |
| `image.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/image> | Image with caption |
| `video.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/video> | Video with caption |
| `document.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/document> | Document with caption and filename |
| `sticker.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/sticker> | Animated sticker |
| `location.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/location> | Location |
| `contacts.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/contacts> | Shared contact card |
| `reaction.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/reaction> | Reaction received ("Receiving a reaction") |
| `reaction-removed.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/reaction> | Reaction removed by the end user (no emoji) |
| `system-user-changed-number.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/system> | System message user_changed_number (carries user_id + previous_user_id) |
| `system-user-changed-user-id.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/system> | System message user_changed_user_id (no phone, no from) |
| `unsupported.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/unsupported> | Unsupported message type (error 131051, messages[].errors) |
| `edit.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/edit> | User edited a message (coexistence numbers) |
| `revoke.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/revoke> | User revoked (deleted) a message (coexistence numbers) |
| `order.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/order> | Catalog order message |
| `value-errors.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/errors> | System/app/account-level error: entry.changes.value.errors (no messages, no statuses) |
| `status-delivered.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages> | delivered status with pricing (CBP model, no pricing.type), from the Overview page |
| `status-sent-pricing.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status> | sent status with conversation and pricing (marketing) |
| `status-sent-minimal.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status> | sent status, v24.0 shape: no conversation, no pricing |
| `status-failed.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status> | failed status with errors[] (code 131049) |
| `bsuid-status-delivered-with-phone.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids> | delivered status: contacts[] with user_id + parent_user_id, recipient_id present, sent to a phone number |
| `bsuid-status-delivered-no-phone.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids> | delivered status sent to a BSUID: wa_id and recipient_id omitted |
| `bsuid-status-failed.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids> | failed status sent to a phone number: no contacts[], no recipient_user_id |
| `bsuid-text-no-phone.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids> | incoming text from a username user: from_user_id + contacts[].user_id, no from, no wa_id |
| `user-preferences.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/user_preferences> | user_preferences webhook (marketing resume, with user_id) |
| `phone-number-quality-update.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/phone_number_quality_update> | phone_number_quality_update (THROUGHPUT_UPGRADE) |
| `phone-number-name-update.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/phone_number_name_update> | phone_number_name_update (APPROVED) |
| `account-alerts.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_alerts> | account_alerts sample |
| `business-capability-update.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/business_capability_update> | business_capability_update sample |
| `message-template-status-update-approved.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update> | message_template_status_update (first sample) |
| `message-template-status-update-rejected.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update> | message_template_status_update (second sample, with rejection_info) |
| `account-update-account-deleted.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event ACCOUNT_DELETED |
| `account-update-account-restriction.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event ACCOUNT_RESTRICTION |
| `account-update-account-violation.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event ACCOUNT_VIOLATION |
| `account-update-ad-account-linked.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event AD_ACCOUNT_LINKED |
| `account-update-auth-intl-price-eligibility-update.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event AUTH_INTL_PRICE_ELIGIBILITY_UPDATE |
| `account-update-disabled-update.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event DISABLED_UPDATE |
| `account-update-mm-lite-terms-signed.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event MM_LITE_TERMS_SIGNED |
| `account-update-partner-added.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event PARTNER_ADDED |
| `account-update-partner-app-installed.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event PARTNER_APP_INSTALLED |
| `account-update-partner-app-uninstalled.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event PARTNER_APP_UNINSTALLED |
| `account-update-partner-client-certification-status-update.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event PARTNER_CLIENT_CERTIFICATION_STATUS_UPDATE |
| `account-update-partner-removed.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event PARTNER_REMOVED |
| `account-update-partner-removed-disconnection.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event PARTNER_REMOVED |
| `account-update-business-primary-location-country-update.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event BUSINESS_PRIMARY_LOCATION_COUNTRY_UPDATE |
| `account-update-volume-based-pricing-tier-update.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event VOLUME_BASED_PRICING_TIER_UPDATE |
| `account-update-account-offboarded.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event ACCOUNT_OFFBOARDED |
| `account-update-account-reconnected.json` | <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update> | account_update event ACCOUNT_RECONNECTED |

Retrieved: 2026-10-19.

## Notes

- `account-alerts.json` contains a literal `<BUSINESS_PORTFOLIO_NAME>` inside a description string, exactly as Meta publishes it. It is valid JSON, so it was left as is; `whatsapp.test.ts` allows that one placeholder and no other.
- The HTML-entity decoding is the only difference from the raw-markdown source. Numeric entities (an emoji in `reaction.json`) decode to the character they spell.
- Most per-type samples (text, image, interactive, ...) predate BSUIDs: they carry `from` and `wa_id` and no `user_id`. They are kept as published. `whatsapp.test.ts` runs them as published (a message with no BSUID is `Ignored{no_user_id}`) and again with `contacts[].user_id` and `messages[].from_user_id` added, which is what Meta's BSUID page says every incoming message type gains.

## Not captured: Meta publishes no sample (nothing here is invented)

- Status `read` and `played`: the status page documents the values but its samples show only `sent`, `delivered` and `failed`. The tests build a `read`/`played` status by editing `bsuid-status-delivered-with-phone.json`, in memory only.
- Incoming BSUID fields on any message type other than text (Meta: "the changes are the same for all incoming message types"). Only `bsuid-text-no-phone.json` exists.
- A Click to WhatsApp referral on a non-text message, with `video_url`/`thumbnail_url`, or the Status-ad variant without `ctwa_clid` (the page describes it; the sample shows the image-ad text case). The tests edit `text-ctwa-referral.json` in memory for the last.
- `interactive` flavours other than `list_reply`, `button_reply` and `product`: a WhatsApp Flow response (`nfm_reply`), an address reply.
- `request_welcome` (Meta removed it from its docs; no sample). The tests build one from a text fixture, in memory.
- The `131060` (message unavailable) variant of `unsupported.json`: the page says the shape is the same and only the `errors` values differ.
- `user_preferences` with `value: "stop"`: only the `resume` sample is published.
- A group status (`recipient_type: "group"`): the BSUID page documents it with an annotated template that is not valid JSON, not a sample.
- Calling, coexistence history, `smb_*` and group-management webhooks: out of scope for the agent (not read by the normaliser).
