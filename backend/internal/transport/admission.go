package transport

import "time"

type tokenBucket struct {
	tokens float64
	at     time.Time
}

func (b *tokenBucket) take(now time.Time, rate, capacity float64) bool {
	b.tokens = min(capacity, b.tokens+now.Sub(b.at).Seconds()*rate)
	b.at = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
func (s *Server) admit(peer string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.admissions == nil {
		s.admissions = make(map[string]*tokenBucket)
	}
	bucket := s.admissions[peer]
	if bucket == nil {
		// Expired buckets are discarded before enforcing the bounded IP table.
		for key, value := range s.admissions {
			if now.Sub(value.at) > time.Minute {
				delete(s.admissions, key)
			}
		}
		if len(s.admissions) >= 4096 {
			return false
		}
		bucket = &tokenBucket{tokens: 10, at: now}
		s.admissions[peer] = bucket
	}
	return bucket.take(now, 0.5, 10)
}
