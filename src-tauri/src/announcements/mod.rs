//! Native announcement verification, bounded transport/media, local store and Tauri service/IPC.
//! Production stays unconfigured until the reviewed public signing key is provisioned.

mod cache;
pub mod commands;
mod de;
mod dto;
mod service;
pub use service::AnnouncementService;
mod limits;
mod media;
mod model;
mod store;
mod store_io;
mod store_state;
mod transport;
mod verify;
pub use model::{
    parse_payload, AnnouncementContent, AnnouncementImage, AnnouncementItem, AnnouncementLink,
    AnnouncementLocales, AnnouncementPayload, PayloadError,
};
pub use store::{
    AnnouncementStore, FetchMetadata, ReadState, StoreError, StoreSnapshot, StoredFeed,
};
pub use verify::{verify_signed_envelope, VerifyError};

#[cfg(test)]
mod verify_tests;

#[cfg(test)]
mod model_tests;

#[cfg(test)]
mod store_tests;

#[cfg(test)]
mod dependency_tests;

#[cfg(test)]
mod transport_tests;

#[cfg(test)]
mod media_tests;
