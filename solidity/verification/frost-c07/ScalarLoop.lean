import Mathlib.Algebra.Group.Basic
import Init.Data.BitVec.Lemmas
import Mathlib.Tactic.Ring

/-!
Partial C-07 scalar-loop argument over an arbitrary additive commutative group.
This proves the big-endian double-and-add fold, including empty and leading-zero
bit lists. It does not assume that Solidity Jacobian operations implement this
group: coordinate/exception correspondence and the uint256 loop binding remain
separate obligations. No verifier acceptance predicate is established here.
-/
namespace FrostC07.ScalarLoop

def bitValue (b : Bool) : Nat := if b then 1 else 0

def scalarStep (n : Nat) (b : Bool) : Nat := 2 * n + bitValue b

def scalarBE (bits : List Bool) : Nat := bits.foldl scalarStep 0

def groupStep {A : Type*} [AddCommGroup A] (P acc : A) (b : Bool) : A :=
  (acc + acc) + if b then P else 0

def multiplyBE {A : Type*} [AddCommGroup A] (P : A) (bits : List Bool) : A :=
  bits.foldl (groupStep P) 0

theorem groupStep_correct {A : Type*} [AddCommGroup A] (P : A) (n : Nat)
    (b : Bool) : groupStep P (n • P) b = scalarStep n b • P := by
  cases b <;> simp [groupStep, scalarStep, bitValue, add_nsmul, mul_nsmul,
    two_nsmul, nsmul_add]

theorem fold_correct {A : Type*} [AddCommGroup A] (P : A) (bits : List Bool)
    (n : Nat) :
    bits.foldl (groupStep P) (n • P) = bits.foldl scalarStep n • P := by
  induction bits generalizing n with
  | nil => rfl
  | cons b bits ih =>
      simp only [List.foldl_cons, groupStep_correct]
      exact ih (scalarStep n b)

theorem multiplyBE_correct {A : Type*} [AddCommGroup A] (P : A)
    (bits : List Bool) : multiplyBE P bits = scalarBE bits • P := by
  simpa [multiplyBE, scalarBE, zero_nsmul] using fold_correct P bits 0

@[simp] theorem scalarBE_nil : scalarBE [] = 0 := rfl

@[simp] theorem multiplyBE_nil {A : Type*} [AddCommGroup A] (P : A) :
    multiplyBE P [] = 0 := rfl

@[simp] theorem scalarBE_leading_zero (bits : List Bool) :
    scalarBE (false :: bits) = scalarBE bits := by
  simp [scalarBE, scalarStep, bitValue]

@[simp] theorem multiplyBE_leading_zero {A : Type*} [AddCommGroup A] (P : A)
    (bits : List Bool) : multiplyBE P (false :: bits) = multiplyBE P bits := by
  simp [multiplyBE, groupStep]

theorem multiplyBE_zero_bits {A : Type*} [AddCommGroup A] (P : A) (n : Nat) :
    multiplyBE P (List.replicate n false) = 0 := by
  induction n with
  | zero => simp
  | succ n ih => simpa [List.replicate_succ] using ih

theorem scalar_fold_offset (bits : List Bool) (n : Nat) :
    bits.foldl scalarStep n = n * 2 ^ bits.length + scalarBE bits := by
  induction bits generalizing n with
  | nil => simp [scalarBE]
  | cons b bits ih =>
      simp only [List.foldl_cons, List.length_cons, scalarBE, scalarStep]
      rw [ih, ih]
      simp only [scalarStep, Nat.pow_succ]
      ring

theorem scalarBE_cons (b : Bool) (bits : List Bool) :
    scalarBE (b :: bits) = bitValue b * 2 ^ bits.length + scalarBE bits := by
  simpa [scalarBE, scalarStep] using scalar_fold_offset bits (bitValue b)

theorem scalarBE_eq_ofBoolListBE_toNat (bits : List Bool) :
    scalarBE bits = (BitVec.ofBoolListBE bits).toNat := by
  induction bits with
  | nil => rfl
  | cons b bits ih =>
      rw [scalarBE_cons, BitVec.ofBoolListBE, BitVec.toNat_cons', ← ih]
      cases b <;> simp [bitValue, Nat.shiftLeft_eq]

/-- Exactly 256 bits, visited from bit 255 down to bit 0. -/
def bits256 (scalar : BitVec 256) : List Bool :=
  (List.range 256).map fun i => scalar.getLsbD (255 - i)

@[simp] theorem bits256_length (scalar : BitVec 256) :
    (bits256 scalar).length = 256 := by
  simp [bits256]

theorem scalarBE_bits256 (scalar : BitVec 256) :
    scalarBE (bits256 scalar) = scalar.toNat := by
  rw [scalarBE_eq_ofBoolListBE_toNat]
  apply Nat.eq_of_testBit_eq
  intro i
  simp only [BitVec.testBit_toNat, BitVec.getLsbD_ofBoolListBE, bits256_length]
  by_cases hi : i < 256
  · have hj : 256 - 1 - i < (bits256 scalar).length := by
      rw [bits256_length]
      omega
    rw [List.getD_eq_getElem?_getD, List.getElem?_eq_getElem hj]
    simp only [Option.getD_some, hi, decide_true, Bool.true_and]
    simp only [bits256, List.getElem_map, List.getElem_range]
    congr 1
    omega
  · simp [hi, BitVec.getLsbD_ge scalar i (by omega)]

def multiply256 {A : Type*} [AddCommGroup A] (P : A)
    (scalar : BitVec 256) : A := multiplyBE P (bits256 scalar)

/-- The extracted-bit fold is correct; Solidity source binding remains open. -/
theorem multiply256_fold_correct {A : Type*} [AddCommGroup A] (P : A)
    (scalar : BitVec 256) :
    multiply256 P scalar = scalarBE (bits256 scalar) • P :=
  multiplyBE_correct P (bits256 scalar)

/-- Abstract 256-step group multiplication for every unsigned 256-bit scalar.
This does not qualify the Solidity loop or Jacobian implementation. -/
theorem multiply256_correct {A : Type*} [AddCommGroup A] (P : A)
    (scalar : BitVec 256) : multiply256 P scalar = scalar.toNat • P := by
  rw [multiply256_fold_correct, scalarBE_bits256]

#print axioms fold_correct
#print axioms multiplyBE_correct
#print axioms multiplyBE_zero_bits
#print axioms bits256_length
#print axioms multiply256_fold_correct
#print axioms scalarBE_bits256
#print axioms multiply256_correct

end FrostC07.ScalarLoop
