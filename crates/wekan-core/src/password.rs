use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use password_hash::rand_core::OsRng;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PasswordError {
    #[error("パスワードが空です")]
    Empty,
    #[error("パスワードのハッシュ化に失敗しました")]
    Hash,
    #[error("パスワードのハッシュが不正です")]
    InvalidHash,
}

pub fn hash_password(password: &str) -> Result<String, PasswordError> {
    if password.is_empty() {
        return Err(PasswordError::Empty);
    }
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| PasswordError::Hash)
}

pub fn verify_password(password: &str, hash: &str) -> Result<bool, PasswordError> {
    let parsed = PasswordHash::new(hash).map_err(|_| PasswordError::InvalidHash)?;
    match Argon2::default().verify_password(password.as_bytes(), &parsed) {
        Ok(()) => Ok(true),
        Err(argon2::password_hash::Error::Password) => Ok(false),
        Err(_) => Err(PasswordError::InvalidHash),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let hash = hash_password("correct horse").unwrap();
        assert!(verify_password("correct horse", &hash).unwrap());
        assert!(!verify_password("wrong", &hash).unwrap());
    }

    #[test]
    fn empty_is_rejected() {
        assert_eq!(hash_password(""), Err(PasswordError::Empty));
    }
}
