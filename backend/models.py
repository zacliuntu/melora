from pydantic import BaseModel, ConfigDict, Field, model_validator


class Note(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")
    id: str = Field(min_length=1, max_length=80)
    pitch: int = Field(ge=0, le=127, strict=True)
    start: float = Field(ge=0, le=300)
    end: float = Field(gt=0, le=300)
    velocity: int = Field(default=90, ge=1, le=127, strict=True)

    @model_validator(mode="after")
    def duration(self):
        if self.end - self.start < 0.025 - 1e-8:
            raise ValueError("音符长度至少为 25 毫秒")
        return self


class Revision(BaseModel):
    expected_revision: int = Field(ge=0)


class Save(Revision):
    notes: list[Note] = Field(max_length=10000)
    bpm: float = Field(default=120, ge=30, le=300, allow_inf_nan=False)


class Confirm(Revision):
    human_confirmed: bool


class Restore(Revision):
    version: int = Field(ge=1)
