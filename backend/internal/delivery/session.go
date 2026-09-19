package delivery

import (
	"context"
	"errors"
	"time"
)

type Session struct{}
type PreparedFlush struct{}

func NewSession(string, StateSource, Options) *Session { return &Session{} }
func (*Session) PrepareSubscribe(SubscribeCommand) (PreparedFlush, error) {
	return PreparedFlush{}, errors.New("not implemented")
}
func (*Session) PrepareFlush(int64) PreparedFlush { return PreparedFlush{} }
func (*Session) Cursors() Cursors                 { return Cursors{} }
func (*Session) CloseCode() int                   { return 0 }
func (PreparedFlush) Frames() []Frame             { return nil }
func (PreparedFlush) Commit(context.Context, FrameSink) (time.Duration, error) {
	return 0, errors.New("not implemented")
}
