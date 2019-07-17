import crypto from 'crypto';
import { getSlackSecretWithKey } from './utils/secrets';
import { getUserProfile, postMessage } from './services/slack';
import { getSettingsForUsers, upsertStatusMappings, UserSettings, upsertDefaultStatus } from './services/dynamo';
import config from '../config';
import { slackInstallUrl } from './utils/urls';

const MILLIS_IN_SEC = 1000;
const FIVE_MIN_IN_SEC = 300;
const EMPTY_RESPONSE_BODY = {};

type ApiGatewayEvent = {
  headers: {
    [header: string]: string;
  };
  body: string;
};

type SlackEvent = {
  client_msg_id: string;
  type: string;
  subtype?: string;
  text: string;
  user?: string;
  ts: string;
  team: string;
  channel: string;
  event_ts: string;
  channel_type: string;
};

type SlackEventCallback = {
  token: string;
  team_id: string;
  api_app_id: string;
  event: SlackEvent;
  type: string;
  event_id: string;
  event_time: number;
  authed_users: Array<string>;
};

interface SlackResponse {}

const validateTimestamp = (slackRequestTimestampInSec: number): boolean => {
  const currentTimeInSec = Math.floor(new Date().getTime() / MILLIS_IN_SEC);
  return Math.abs(currentTimeInSec - slackRequestTimestampInSec) < FIVE_MIN_IN_SEC;
};

const validateSlackRequest = async (event: ApiGatewayEvent): Promise<boolean> => {
  const requestTimestamp: number = +event.headers['X-Slack-Request-Timestamp'];
  if (!validateTimestamp(requestTimestamp)) {
    return false;
  }

  const signingSecret = await getSlackSecretWithKey('signing-secret');
  const hmac = crypto.createHmac('sha256', signingSecret);

  const requestSignature = event.headers['X-Slack-Signature'];
  const [version, slackHash] = requestSignature.split('=');

  const calculatedSignature = hmac.update(`${version}:${requestTimestamp}:${event.body}`).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(calculatedSignature, 'utf8'), Buffer.from(slackHash, 'utf8'));
};

const serializeStatusMappings = (userSettings: UserSettings): string[] => {
  if (userSettings.statusMappings) {
    const serialized = userSettings.statusMappings.map(
      m =>
        `\n${m.slackStatus.emoji} \`${m.calendarText}\` ${
          m.slackStatus.text ? 'uses status `' + m.slackStatus.text + '`' : ''
        }`,
    );
    return serialized;
  }

  return [];
};

const handleShow = async (userSettings: UserSettings): Promise<string> => {
  const serialized = serializeStatusMappings(userSettings);
  if (serialized.length) {
    return `Here's what I've got for you:${serialized}`;
  }

  return "You don't have any status mappings yet. Try `set`";
};

const handleSet = async (userSettings: UserSettings, args: string[]): Promise<string> => {
  const defaults: { [prop: string]: string } = { meeting: '', message: '', emoji: '' };
  for (let arg of args) {
    const [key, value] = arg.split('=');
    if (key in defaults) {
      defaults[key] = value;
    }
  }

  if (!defaults.meeting) {
    return `You must specify a meeting using \`meeting="My Meeting"\`.`;
  }

  if (!userSettings.statusMappings) {
    userSettings.statusMappings = [];
  }

  const existingMeeting = userSettings.statusMappings.find(
    m => m.calendarText.toLowerCase() === defaults.meeting.toLowerCase(),
  );

  const slackStatus = {
    text: defaults.message || defaults.meeting,
    emoji: defaults.emoji,
  };

  if (existingMeeting) {
    existingMeeting.slackStatus = slackStatus;
  } else {
    userSettings.statusMappings.push({
      calendarText: defaults.meeting,
      slackStatus,
    });
  }

  const updated = await upsertStatusMappings(userSettings);
  const serialized = serializeStatusMappings(updated);

  return `Here's what I got: ${serialized}`;
};

const handleRemove = async (userSettings: UserSettings, args: string[]): Promise<string> => {
  // TODO: implement
  return 'Not implemented';
};

const handleSetDefault = async (userSettings: UserSettings, args: string[]): Promise<string> => {
  const defaults: { [prop: string]: string | '' } = { message: '', emoji: '' };
  for (let arg of args) {
    const [key, value] = arg.split('=');
    if (key in defaults) {
      defaults[key] = value;
    }
  }

  const { message, emoji } = defaults;

  if (!message && !emoji) {
    return 'Please set a default `message` and/or `emoji`.';
  }

  userSettings.defaultStatus = { text: message, emoji: emoji };
  await upsertDefaultStatus(userSettings);

  return `Your default status is ${emoji} \`${message}\`.`;
};

const handleRemoveDefault = async (userSettings: UserSettings): Promise<string> => {
  userSettings.defaultStatus = null;
  await upsertDefaultStatus(userSettings);
  return 'Your default status has been removed.';
};

const commandHandlerMap: { [command: string]: (userSettings: UserSettings, args: string[]) => Promise<string> } = {
  show: handleShow,
  set: handleSet,
  remove: handleRemove,
  'set-default': handleSetDefault,
  'remove-default': handleRemoveDefault,
};

const handleSlackEventCallback = async ({
  event: { type, subtype, channel, channel_type, user, text },
}: SlackEventCallback): Promise<SlackResponse> => {
  if (type !== 'message' || channel_type !== 'im') {
    console.log(`Event type ${type}/${channel_type} is not handled by this version.`);
    return EMPTY_RESPONSE_BODY;
  }

  if (subtype === 'bot_message' || !user) {
    // ignore messages from self
    return EMPTY_RESPONSE_BODY;
  }

  const botToken = await getSlackSecretWithKey('bot-token');
  const sendMessage = async (message: string): Promise<SlackResponse> => {
    await postMessage(botToken, { text: message, channel: channel });
    return EMPTY_RESPONSE_BODY;
  };

  const userProfile = await getUserProfile(botToken, user);
  if (!userProfile) {
    return await sendMessage('Something went wrong fetching your user profile. Maybe try again?');
  }
  const userEmail = userProfile.email;

  const userSettings = await getSettingsForUsers([userEmail]);
  if (!userSettings.length || !userSettings[0].slackToken) {
    return await sendMessage(`Hello :wave:

You need to authorize me before we can do anything else: ${slackInstallUrl()}`);
  }

  const command = text;
  const tokens = command.match(/[\w]+=[""][^""]+[""]|[^ """]+/g) || [];
  const subcommand = tokens[0];
  const args = tokens.slice(1);

  if (subcommand in commandHandlerMap) {
    const message = await commandHandlerMap[subcommand](userSettings[0], args);
    return await sendMessage(message);
  }

  return await sendMessage(`:shrug: Maybe try one of these:
  - \`help\`
  - \`show\`
  - \`set\`
  - \`set-default\`
  - \`remove\`
  - \`remove-default\``);
};

export const handler = async (event: ApiGatewayEvent) => {
  let body = JSON.parse(event.body);

  if (!(await validateSlackRequest(event))) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Request was invalid' }),
    };
  }

  let responseBody: SlackResponse;
  switch (body.type) {
    case 'url_verification':
      responseBody = { challenge: body.challenge };
      break;
    case 'event_callback':
      responseBody = await handleSlackEventCallback(body as SlackEventCallback);
      break;
    default:
      console.log('Event type not recognized: ' + body.type);
      console.log(event.body);
      responseBody = EMPTY_RESPONSE_BODY;
  }

  let response = {
    statusCode: 200,
    body: JSON.stringify(responseBody),
  };

  return response;
};
