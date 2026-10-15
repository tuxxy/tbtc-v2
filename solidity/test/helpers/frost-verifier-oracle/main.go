// Test-only oracle. Dependency versions are taken from keep-core K-04
// f75b7bc2a56e6b700750e31ce647a7ef90156fc9, not selected from latest releases.
package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"runtime/debug"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/chaincfg/chainhash"
	"github.com/btcsuite/btcd/txscript"
)

type verification struct {
	ID        string
	Key       string
	Message   string
	Signature string
	Valid     bool
}
type tweak struct {
	ID        string
	Key       string
	Root      string
	Valid     bool
	OutputKey string
	Parity    int
}
type result struct {
	Seed    string
	Modules map[string]string
	Verify  []verification
	Tweak   []tweak
}

func hx(b []byte) string     { return "0x" + hex.EncodeToString(b) }
func word(x *big.Int) []byte { return x.FillBytes(make([]byte, 32)) }
func check(key, msg, sig []byte) bool {
	p, e := schnorr.ParsePubKey(key)
	if e != nil {
		return false
	}
	s, e := schnorr.ParseSignature(sig)
	return e == nil && s.Verify(msg, p)
}
func output(id string, key, root []byte) tweak {
	r := tweak{ID: id, Key: hx(key), Root: hx(root)}
	p, e := schnorr.ParsePubKey(key)
	if e != nil {
		return r
	}
	// ComputeTaprootOutputKey reduces its scalar. Check BIP341's strict range
	// first, rather than treating that reduction as the specified relation.
	h := chainhash.TaggedHash(chainhash.TagTapTweak, key, root)
	if new(big.Int).SetBytes(h[:]).Cmp(btcec.S256().N) >= 0 {
		return r
	}
	q := txscript.ComputeTaprootOutputKey(p, root)
	if !q.IsOnCurve() {
		return r
	}
	r.Valid = true
	r.OutputKey = hx(schnorr.SerializePubKey(q))
	r.Parity = int(q.SerializeCompressed()[0] & 1)
	return r
}
func main() {
	const seed = "C07-keep-core-btcd-differential-v1"
	r := result{Seed: seed, Modules: map[string]string{}}
	if b, ok := debug.ReadBuildInfo(); ok {
		for _, d := range b.Deps {
			if d.Replace != nil {
				panic("Oracle dependency replacement is not permitted: " + d.Path)
			}
			r.Modules[d.Path] = d.Version
		}
	}
	counter := uint64(0)
	next := func() []byte {
		var c [8]byte
		binary.BigEndian.PutUint64(c[:], counter)
		counter++
		h := sha256.Sum256(append([]byte(seed), c[:]...))
		return h[:]
	}
	add := func(id string, k, m, s []byte) {
		r.Verify = append(r.Verify, verification{id, hx(k), hx(m), hx(s), check(k, m, s)})
	}
	n, p := btcec.S256().N, btcec.S256().P
	for i := 0; i < 8; i++ {
		scalar := new(big.Int).SetBytes(next())
		scalar.Mod(scalar, new(big.Int).Sub(n, big.NewInt(1)))
		scalar.Add(scalar, big.NewInt(1))
		priv, pub := btcec.PrivKeyFromBytes(word(scalar))
		k := schnorr.SerializePubKey(pub)
		m := next()
		var aux [32]byte
		copy(aux[:], next())
		sig, e := schnorr.Sign(priv, m, schnorr.CustomNonce(aux))
		if e != nil {
			panic(e)
		}
		s := sig.Serialize()
		prefix := fmt.Sprintf("seed-%d/", i)
		add(prefix+"valid", k, m, s)
		changed := append([]byte(nil), s...)
		changed[i] ^= 1
		add(prefix+"signature-flip", k, m, changed)
		mm := append([]byte(nil), m...)
		mm[i] ^= 1
		add(prefix+"message-flip", k, mm, s)
		_, other := btcec.PrivKeyFromBytes(next())
		add(prefix+"foreign-key", schnorr.SerializePubKey(other), m, s)
		for _, boundary := range []struct {
			name string
			v    *big.Int
		}{{"zero", big.NewInt(0)}, {"N", n}, {"N-minus-one", new(big.Int).Sub(n, big.NewInt(1))}} {
			changed = append([]byte(nil), s...)
			copy(changed[32:], word(boundary.v))
			add(prefix+"s-"+boundary.name, k, m, changed)
		}
		changed = append([]byte(nil), s...)
		copy(changed[32:], word(new(big.Int).Sub(n, new(big.Int).SetBytes(s[32:]))))
		add(prefix+"N-minus-s", k, m, changed)
		changed = append([]byte(nil), s...)
		copy(changed[:32], word(p))
		add(prefix+"r-P", k, m, changed)
		add(prefix+"random", next(), next(), append(next(), next()...))
		for _, length := range []int{0, 1, 63, 65} {
			malformed := make([]byte, length)
			copy(malformed, s)
			add(prefix+fmt.Sprintf("length-%d", length), k, m, malformed)
		}
		r.Tweak = append(r.Tweak, output(prefix+"random-root", k, next()), output(prefix+"zero-root", k, make([]byte, 32)))
		if i == 0 {
			r.Tweak = append(r.Tweak, output("BIP86-empty-root", k, nil))
		}
		for j, b := range [][]byte{make([]byte, 32), word(p), word(n), word(new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1)))} {
			sig, e = schnorr.Sign(priv, b, schnorr.CustomNonce(aux))
			if e != nil {
				panic(e)
			}
			add(prefix+fmt.Sprintf("boundary-message-%d", j), k, b, sig.Serialize())
		}
	}
	for _, b := range []struct {
		name string
		v    *big.Int
	}{{"zero", big.NewInt(0)}, {"one", big.NewInt(1)}, {"P-minus-one", new(big.Int).Sub(p, big.NewInt(1))}, {"P", p}, {"P-plus-one", new(big.Int).Add(p, big.NewInt(1))}, {"max", new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))}} {
		k := word(b.v)
		add("key-"+b.name, k, make([]byte, 32), make([]byte, 64))
		r.Tweak = append(r.Tweak, output("key-"+b.name, k, make([]byte, 32)))
	}
	if e := json.NewEncoder(os.Stdout).Encode(r); e != nil {
		panic(e)
	}
}
