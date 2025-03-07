import * as React from 'react';

import { Box, Stack, useTheme } from '@mui/joy';
import { SxProps } from '@mui/joy/styles/types';

import { ApiChatInput } from '../pages/api/chat';
import { ApplicationBar } from '@/components/ApplicationBar';
import { Composer } from '@/components/Composer';
import { Conversation } from '@/components/Conversation';
import { DMessage, useActiveConfiguration, useActiveConversation, useChatStore } from '@/lib/store-chats';
import { SystemPurposes } from '@/lib/data';
import { useSettingsStore } from '@/lib/store';


function createDMessage(role: DMessage['role'], text: string): DMessage {
  return {
    id: Math.random().toString(36).substring(2, 15), // use uuid4 !!
    text: text,
    sender: role === 'user' ? 'You' : 'Bot',
    role: role,
    modelName: '',
    modelTokensCount: 0,
    avatar: null,
    created: Date.now(),
    updated: null,
  };
}


/**
 * Main function to send a message to the assistant and receive a response (streaming)
 */
async function _streamAssistantResponseMessage(
  conversationId: string, history: DMessage[],
  apiKey: string, chatModelId: string, abortSignal: AbortSignal,
  addMessage: (conversationId: string, message: DMessage) => void,
  editMessage: (conversationId: string, messageId: string, updatedMessage: Partial<DMessage>) => void,
) {

  const payload: ApiChatInput = {
    apiKey: apiKey,
    model: chatModelId,
    messages: history.map(({ role, text }) => ({
      role: role,
      content: text,
    })),
  };

  try {

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abortSignal,
    });

    if (response.body) {
      const _message: DMessage = createDMessage('assistant', '');
      addMessage(conversationId, _message);

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');

      // loop forever until the read is done, or the abort controller is triggered
      let messageText = '';
      let parsedFirstPacket = false;
      while (true) {
        const { value, done } = await reader.read();

        if (done) break;

        messageText += decoder.decode(value);

        // there may be a JSON object at the beginning of the message, which contains the model name (streaming workaround)
        if (!parsedFirstPacket && messageText.startsWith('{')) {
          const endOfJson = messageText.indexOf('}');
          if (endOfJson > 0) {
            const json = messageText.substring(0, endOfJson + 1);
            messageText = messageText.substring(endOfJson + 1);
            try {
              const parsed = JSON.parse(json);
              editMessage(conversationId, _message.id, { modelName: parsed.model });
              parsedFirstPacket = true;
            } catch (e) {
              // error parsing JSON, ignore
              console.log('Error parsing JSON: ' + e);
            }
          }
        }

        editMessage(conversationId, _message.id, { text: messageText });
      }
    }

  } catch (error: any) {
    if (error?.name === 'AbortError') {
      // expected, the user clicked the "stop" button
    } else {
      // TODO: show an error to the UI
      console.error('Fetch request error:', error);
    }
  }
}


export function ChatArea(props: { onShowSettings: () => void, sx?: SxProps }) {
  const theme = useTheme();

  const { chatModelId, systemPurposeId } = useActiveConfiguration();
  const { id: activeConversationId, messages } = useActiveConversation();
  const { addMessage, editMessage, replaceMessages } = useChatStore(state => ({ addMessage: state.addMessage, editMessage: state.editMessage, replaceMessages: state.replaceMessages }));
  const [abortController, setAbortController] = React.useState<AbortController | null>(null);


  const runAssistant = async (conversationId: string, history: DMessage[]) => {
    replaceMessages(conversationId, history);

    // when an abort controller is set, the UI switches to the "stop" mode
    const controller = new AbortController();
    setAbortController(controller);

    const apiKey = useSettingsStore.getState().apiKey;
    await _streamAssistantResponseMessage(conversationId, history, apiKey, chatModelId, controller.signal, addMessage, editMessage);

    // and we're done with this message/api call
    setAbortController(null);
  };


  const sendUserMessage = async (userText: string) => {
    const history = [...messages];

    // prepend 'system' message if missing
    if (!history.length) {
      const systemPurpose = SystemPurposes[systemPurposeId].systemMessage
        .replaceAll('{{Today}}', new Date().toISOString().split('T')[0]);
      history.push(createDMessage('system', systemPurpose));
    }

    history.push(createDMessage('user', userText));

    await runAssistant(activeConversationId, history);
  };


  const handleStopGeneration = () => abortController?.abort();

  const handleConversationClear = () => replaceMessages(activeConversationId, []);

  return (
    <Stack
      sx={{
        minHeight: '100vh',
        position: 'relative',
        ...(props.sx || {}),
      }}>

      <ApplicationBar
        onClearConversation={handleConversationClear} onShowSettings={props.onShowSettings}
        sx={{
          position: 'sticky', top: 0, zIndex: 20,
          ...(process.env.NODE_ENV === 'development' ? { background: theme.vars.palette.danger.solidBg } : {}),
        }} />

      <Conversation
        disableSend={!!abortController} runAssistant={runAssistant}
        sx={{
          flexGrow: 1,
          background: theme.vars.palette.background.level1,
          overflowY: 'hidden',
        }} />

      <Box
        sx={{
          position: 'sticky', bottom: 0, zIndex: 21,
          background: theme.vars.palette.background.body,
          borderTop: `1px solid ${theme.vars.palette.divider}`,
          p: { xs: 1, md: 2 },
        }}>
        <Composer
          disableSend={!!abortController}
          sendMessage={sendUserMessage} stopGeneration={handleStopGeneration} isDeveloperMode={systemPurposeId === 'Developer'}
        />
      </Box>

    </Stack>
  );
}
