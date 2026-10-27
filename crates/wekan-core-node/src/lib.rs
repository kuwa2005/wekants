use napi::bindgen_prelude::*;
use napi_derive::napi;
use wekan_core::{self, MoveError};

#[napi(object)]
pub struct MoveCardResult {
    pub rank: i64,
    pub needs_rebalance: bool,
}

#[napi]
pub fn move_card(prev: Option<i64>, next: Option<i64>) -> Result<MoveCardResult> {
    match wekan_core::move_card(prev, next) {
        Ok(moved) => Ok(MoveCardResult {
            rank: moved.rank,
            needs_rebalance: false,
        }),
        Err(MoveError::NeedsRebalance) => Ok(MoveCardResult {
            rank: 0,
            needs_rebalance: true,
        }),
        Err(MoveError::InvertedNeighbors) => {
            Err(Error::from_reason("隣の順位が逆です"))
        }
    }
}

#[napi]
pub fn rebalance_ranks(count: u32) -> Vec<i64> {
    wekan_core::rebalance_ranks(count as usize)
}

#[napi]
pub fn assert_board_access(owner_id: String, user_id: String) -> Result<()> {
    wekan_core::assert_board_access(&owner_id, &user_id)
        .map_err(|err| Error::from_reason(err.to_string()))
}

#[napi]
pub fn validate_title(title: String) -> Result<()> {
    wekan_core::validate_title(&title).map_err(|err| Error::from_reason(err.to_string()))
}

#[napi]
pub fn hash_password(password: String) -> Result<String> {
    wekan_core::hash_password(&password).map_err(|err| Error::from_reason(err.to_string()))
}

#[napi]
pub fn verify_password(password: String, hash: String) -> Result<bool> {
    wekan_core::verify_password(&password, &hash)
        .map_err(|err| Error::from_reason(err.to_string()))
}
