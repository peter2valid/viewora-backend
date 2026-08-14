import test from 'node:test'
import assert from 'node:assert/strict'

import { step } from '../conversation/engine.js'
import type { IncomingMessage, SessionContext, SessionState } from '../conversation/types.js'

function textMessage(text: string): IncomingMessage {
  return {
    id: 'm1',
    channel: 'telegram',
    providerEventId: '1',
    sender: { id: 'sender-1' },
    replyTo: 'sender-1',
    timestamp: new Date().toISOString(),
    type: 'text',
    payload: { text },
  }
}

function imageMessage(): IncomingMessage {
  return {
    id: 'm2',
    channel: 'telegram',
    providerEventId: '2',
    sender: { id: 'sender-1' },
    replyTo: 'sender-1',
    timestamp: new Date().toISOString(),
    type: 'image',
    payload: { providerMediaId: 'file-abc' },
  }
}

test('new session greets with the menu and moves to active', () => {
  const result = step('new', {}, textMessage('hi'))
  assert.equal(result.nextState, 'active')
  assert.equal(result.actions[0].kind, 'reply')
})

test('full happy path: menu -> name -> photos -> done', () => {
  let state: SessionState = 'new'
  let context: SessionContext = {}

  // greeting
  let r = step(state, context, textMessage('hi'))
  state = r.nextState
  context = r.nextContext

  // choose "1" (residential)
  r = step(state, context, textMessage('1'))
  state = r.nextState
  context = r.nextContext
  assert.equal(context.spaceType, 'residential')

  // give a name -> should emit create_property and move to awaiting_media
  r = step(state, context, textMessage('2 BHK Kilimani'))
  state = r.nextState
  context = r.nextContext
  assert.equal(state, 'awaiting_media')
  assert.ok(r.actions.some((a) => a.kind === 'create_property'))

  // "done" with zero photos should be rejected
  r = step(state, context, textMessage('done'))
  assert.equal(r.nextState, 'awaiting_media')
  assert.ok(r.actions.every((a) => a.kind !== 'send_tour_link'))

  // send a photo
  r = step(state, context, imageMessage())
  state = r.nextState
  context = r.nextContext
  assert.equal(context.photosUploaded, 1)
  assert.ok(r.actions.some((a) => a.kind === 'store_photo'))

  // now "done" should complete
  r = step(state, context, textMessage('done'))
  assert.equal(r.nextState, 'completed')
  assert.ok(r.actions.some((a) => a.kind === 'send_tour_link'))
})

test('invalid menu choice is rejected without advancing', () => {
  const r = step('active', {}, textMessage('banana'))
  assert.equal(r.nextState, 'active')
  assert.equal(r.nextContext.spaceType, undefined)
})

test('a completed session restarts fresh on the next message', () => {
  const r = step('completed', { spaceType: 'residential', propertyId: 'old-id' }, textMessage('hi'))
  assert.equal(r.nextState, 'active')
  assert.deepEqual(r.nextContext, {})
})
