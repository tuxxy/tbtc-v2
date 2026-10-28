import Mathlib.Data.ZMod.Basic
import Mathlib.Tactic.NormNum

/-!
One bounded source-correspondence obligation for FrostSecp256k1.sub.
The modulus is the exact Solidity P constant. The Nat expression models EVM
addmod's full-precision addition followed by reduction, not uint256 addition
followed by reduction. The result is proved in ZMod P without asserting P is
prime, without a Field instance, and without establishing EVM bytecode semantics.
No curve order, scalar reduction, lift/hash or named verifier proof is claimed.
-/
namespace FrostC07.CanonicalSubtraction

def secpP : Nat :=
  0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f

def sourceSub (a b : Nat) : Nat := (a + (secpP - b)) % secpP

/-- Under the runtime helper's canonical-input precondition, P-b is a valid
uint256 operand, the addmod result is canonical, and its residue is exactly
subtraction in ZMod P. Primality is not a hypothesis or a conclusion. -/
theorem canonical_sub_binding (a b : Nat) (_ha : a < secpP) (hb : b < secpP) :
    secpP - b < 2 ^ 256 ∧
    sourceSub a b < secpP ∧
    (sourceSub a b : ZMod secpP) = (a : ZMod secpP) - (b : ZMod secpP) := by
  have hp : 0 < secpP := by norm_num [secpP]
  have hpWord : secpP < 2 ^ 256 := by norm_num [secpP]
  have hbLe : b ≤ secpP := Nat.le_of_lt hb
  refine ⟨lt_of_le_of_lt (Nat.sub_le secpP b) hpWord, Nat.mod_lt _ hp, ?_⟩
  unfold sourceSub
  rw [ZMod.natCast_mod, Nat.cast_add, Nat.cast_sub hbLe, ZMod.natCast_self]
  simp [sub_eq_add_neg]

#print axioms canonical_sub_binding

end FrostC07.CanonicalSubtraction
