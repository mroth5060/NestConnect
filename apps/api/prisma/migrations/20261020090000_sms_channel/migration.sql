-- SMS: one more channel type, through any provider's REST API (channels/sms).
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'sms';
