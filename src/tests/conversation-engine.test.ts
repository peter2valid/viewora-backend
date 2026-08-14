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

function imageMessage(width?: number, height?: number): IncomingMessage {
  return {
    id: 'm2',
    channel: 'telegram',
    providerEventId: '2',
    sender: { id: 'sender-1' },
    replyTo: 'sender-1',
    timestamp: new Date().toISOString(),
    type: 'image',
    payload: { providerMediaId: 'file-abc', width, height },
  }
}

test('new session greets with the menu and moves to active', () => {
  const result = step('new', {}, textMessage('hi'))
  assert.equal(result.nextState, 'active')
  assert.equal(result.actions[0].kind, 'reply')
})

test('full happy path: menu -> name -> description -> photos -> done', () => {
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

  // give a name -> should ask for a description next, not create yet
  r = step(state, context, textMessage('2 BHK Kilimani'))
  state = r.nextState
  context = r.nextContext
  assert.equal(state, 'active')
  assert.equal(context.propertyTitle, '2 BHK Kilimani')
  assert.equal(context.description, undefined)
  assert.ok(r.actions.every((a) => a.kind !== 'create_property'))

  // give a description -> NOW create_property fires, with it included, and moves to awaiting_media
  r = step(state, context, textMessage('Sunny corner unit, newly renovated'))
  state = r.nextState
  context = r.nextContext
  assert.equal(state, 'awaiting_media')
  const createAction = r.actions.find((a) => a.kind === 'create_property')
  assert.ok(createAction && createAction.kind === 'create_property')
  assert.equal(createAction.description, 'Sunny corner unit, newly renovated')

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

  // now "done" should complete, telling the user it's processing first
  r = step(state, context, textMessage('done'))
  assert.equal(r.nextState, 'completed')
  assert.ok(r.actions.some((a) => a.kind === 'reply' && a.text.toLowerCase().includes('processing')))
  assert.ok(r.actions.some((a) => a.kind === 'send_tour_link'))
})

test('"skip" on the description prompt creates the property with an empty description', () => {
  const context: SessionContext = { spaceType: 'residential', propertyTitle: 'Studio Colaba' }
  const r = step('active', context, textMessage('skip'))
  assert.equal(r.nextState, 'awaiting_media')
  const createAction = r.actions.find((a) => a.kind === 'create_property')
  assert.ok(createAction && createAction.kind === 'create_property')
  assert.equal(createAction.description, '')
})

test('a ~2:1 photo is recognized as a 360° shot; an ordinary photo is not', () => {
  const context: SessionContext = { spaceType: 'residential', propertyTitle: 'X', description: '' }

  const pano = step('awaiting_media', context, imageMessage(11904, 5952))
  const panoReply = pano.actions.find((a) => a.kind === 'reply')
  assert.ok(panoReply && panoReply.kind === 'reply' && panoReply.text.includes('360°'))

  const regular = step('awaiting_media', context, imageMessage(4032, 3024))
  const regularReply = regular.actions.find((a) => a.kind === 'reply')
  assert.ok(regularReply && regularReply.kind === 'reply' && !regularReply.text.includes('360°'))
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

test('"restart" resets to the menu from any mid-flow state, including a stuck one', () => {
  // e.g. create_property failed earlier this turn: state advanced to
  // awaiting_media but propertyId never got set — exactly what happened live.
  const stuck: SessionContext = { spaceType: 'residential', propertyTitle: 'Juja bnb' }
  const r = step('awaiting_media', stuck, textMessage('restart'))
  assert.equal(r.nextState, 'active')
  assert.deepEqual(r.nextContext, {})
  assert.equal(r.actions[0].kind, 'reply')
})

test('restart keywords are case-insensitive and work from the menu-selection step too', () => {
  const r = step('active', {}, textMessage('Cancel'))
  assert.equal(r.nextState, 'active')
  assert.deepEqual(r.nextContext, {})
})
