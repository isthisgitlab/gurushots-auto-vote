/**
 * Link version 1: the contract a phone page and a desktop that speak link version 1 hold each other to, whatever
 * app version either side runs. Type-only; nothing here exists at runtime. See `core/remote/protocol.ts`
 * (LINK_VERSION) for the rule, and `tests/remote/contractV1.test.ts` for the checks that keep the living types
 * inside it.
 */

import type { AppChannelsV1 } from './channelsApp';
import type { PhotosChannelsV1 } from './channelsPhotos';
import type { ScenarioLibraryChannelsV1 } from './channelsScenarioLibrary';
import type { ScenariosChannelsV1 } from './channelsScenarios';
import type { SettingsChannelsV1 } from './channelsSettings';
import type { VotingChannelsV1 } from './channelsVoting';

/** Every channel a desktop serves a phone (allowed or answered by the host): its arguments and its result. */
export type ChannelsV1 = AppChannelsV1 &
    PhotosChannelsV1 &
    ScenarioLibraryChannelsV1 &
    ScenariosChannelsV1 &
    SettingsChannelsV1 &
    VotingChannelsV1;

export type { EventPayloadsV1 } from './events';
export type {
    AutovoteCommandMessageV1,
    AutovoteStateMessageV1,
    ByeMessageV1,
    EventMessageV1,
    HelloMessageV1,
    InvokeMessageV1,
    PeerMessageV1,
    ResultMessageV1,
} from './envelope';
export type { SettingValuesV1 } from './settingValues';
export type { AutovoteStateV1 } from './shapesConfig';
