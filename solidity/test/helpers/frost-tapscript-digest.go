// Controlled test bridge to pinned btcd v0.24.2. No wallet or production state.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"github.com/btcsuite/btcd/txscript"
	"github.com/btcsuite/btcd/wire"
)

func main() {
	var input struct {
		RawTransaction string `json:"rawTransaction"`
		PrevScript     string `json:"prevScript"`
		Value          int64  `json:"value"`
		Leaf           string `json:"leaf"`
		InputIndex     int    `json:"inputIndex"`
		Prevouts       []struct {
			Value  int64  `json:"value"`
			Script string `json:"script"`
		} `json:"prevouts"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		panic(err)
	}
	decode := func(s string) []byte {
		b, err := hex.DecodeString(s)
		if err != nil {
			panic(err)
		}
		return b
	}
	tx := wire.NewMsgTx(2)
	if err := tx.Deserialize(bytes.NewReader(decode(input.RawTransaction))); err != nil {
		panic(err)
	}
	var stripped bytes.Buffer
	if err := tx.SerializeNoWitness(&stripped); err != nil {
		panic(err)
	}
	result := map[string]string{"strippedHex": hex.EncodeToString(stripped.Bytes()), "txidRPC": tx.TxHash().String()}
	vinSize := wire.VarIntSerializeSize(uint64(len(tx.TxIn)))
	for _, input := range tx.TxIn {
		vinSize += input.SerializeSize()
	}
	plain := stripped.Bytes()
	result["version"] = "0x" + hex.EncodeToString(plain[:4])
	result["inputVector"] = "0x" + hex.EncodeToString(plain[4:4+vinSize])
	result["outputVector"] = "0x" + hex.EncodeToString(plain[4+vinSize:len(plain)-4])
	result["locktime"] = "0x" + hex.EncodeToString(plain[len(plain)-4:])
	if input.Leaf != "" || input.PrevScript != "" || input.Value != 0 || len(input.Prevouts) != 0 {
		var fetcher txscript.PrevOutputFetcher
		if len(input.Prevouts) != 0 {
			if len(input.Prevouts) != len(tx.TxIn) || input.InputIndex < 0 || input.InputIndex >= len(tx.TxIn) {
				panic("complete ordered prevout set and valid input index required")
			}
			multi := txscript.NewMultiPrevOutFetcher(nil)
			for i, previous := range input.Prevouts {
				if previous.Value <= 0 || previous.Value > 2100000000000000 || previous.Script == "" {
					panic("positive bounded prevout value and script required")
				}
				multi.AddPrevOut(tx.TxIn[i].PreviousOutPoint, wire.NewTxOut(previous.Value, decode(previous.Script)))
			}
			fetcher = multi
		} else {
			if len(tx.TxIn) != 1 || input.Value <= 0 || input.InputIndex != 0 {
				panic("single-input positive-value test boundary")
			}
			if input.PrevScript == "" {
				panic("previous output script required")
			}
			fetcher = txscript.NewCannedPrevOutputFetcher(decode(input.PrevScript), input.Value)
		}
		hashes := txscript.NewTxSigHashes(tx, fetcher)
		var digest []byte
		var err error
		if input.Leaf != "" {
			digest, err = txscript.CalcTapscriptSignaturehash(hashes, txscript.SigHashDefault, tx, input.InputIndex, fetcher, txscript.NewBaseTapLeaf(decode(input.Leaf)))
			result["spendType"] = "script-path"
		} else {
			digest, err = txscript.CalcTaprootSignatureHash(hashes, txscript.SigHashDefault, tx, input.InputIndex, fetcher)
			result["spendType"] = "key-path"
		}
		if err != nil {
			panic(err)
		}
		result["digest"] = hex.EncodeToString(digest)
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
