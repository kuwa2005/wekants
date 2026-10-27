use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
#[error("このボードには入れません")]
pub struct AccessError;

pub fn assert_board_access(owner_id: &str, user_id: &str) -> Result<(), AccessError> {
    if owner_id == user_id && !user_id.is_empty() {
        Ok(())
    } else {
        Err(AccessError)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_may_access() {
        assert_board_access("u1", "u1").unwrap();
    }

    #[test]
    fn other_user_is_denied() {
        assert_eq!(assert_board_access("u1", "u2"), Err(AccessError));
    }

    #[test]
    fn empty_user_is_denied() {
        assert_eq!(assert_board_access("", ""), Err(AccessError));
        assert_eq!(assert_board_access("u1", ""), Err(AccessError));
    }
}
