import { Client, ClientOptions } from '@microsoft/microsoft-graph-client';
import { GraphApiAuthenticationProvider } from './graphApiAuthenticationProvider';
import { Token } from 'simple-oauth2';

export enum ShowAs {
  Free = 1,
  Tentative,
  Busy,
  OutOfOffice,
}

export type CalendarEvent = {
  name: string;
  startTime: Date;
  endTime: Date;
  location: string;
  showAs: ShowAs;
  title?: string | '';
};

const toShowAsStatus = (status: string): ShowAs => {
  switch (status.toLowerCase()) {
    case 'oof':
    case 'workingElsewhere': {
      return ShowAs.OutOfOffice;
    }
    case 'busy': {
      return ShowAs.Busy;
    }
    case 'tentative': {
      return ShowAs.Tentative;
    }
    case 'free':
    default: {
      return ShowAs.Free;
    }
  }
};

const userEvents: {
  [email: string]: CalendarEvent[];
} = {
  'jordan.degner@hudl.com': [
    {
      name: 'Quick Chat',
      startTime: new Date('7/14/2019'),
      endTime: new Date('7/15/2019'),
      location: 'Zoom',
      showAs: ShowAs.Busy,
    },
  ],
};

const getAuthenticatedClient = (email: string, token: Token): Client => {
  const options: ClientOptions = {
    authProvider: new GraphApiAuthenticationProvider(email, token),
  };
  return Client.initWithMiddleware(options);
};

export const getEventsForUser = async (email: string, storedToken: Token): Promise<CalendarEvent[] | null> => {
  if (!storedToken) return null;

  const now: Date = new Date();
  const ninetySecondsFromNow: Date = new Date(now);
  ninetySecondsFromNow.setSeconds(now.getSeconds() + 90);

  try {
    const outlookEvents = await getAuthenticatedClient(email, storedToken)
      .api(`/users/${email}/events`)
      .filter(`start/dateTime le '${ninetySecondsFromNow.toISOString()}' and end/dateTime ge '${now.toISOString()}'`)
      .select('start,end,subject,showAs,location,sensitivity')
      .get();
    return outlookEvents.value.map((e: any) => {
      const event: CalendarEvent = {
        name: e.subject,
        startTime: new Date(e.start.dateTime),
        endTime: new Date(e.end.dateTime),
        location: e.location.displayName,
        showAs: toShowAsStatus(e.showAs),
        title: e.sensitivity === 'normal' ? e.subject : 'Private event'
      };
      return event;
    });
  } catch (error) {
    console.error(error);
  }

  return [];
};
