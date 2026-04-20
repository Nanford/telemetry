from abc import ABC, abstractmethod

from app.models import Pose


class PositionProvider(ABC):
    @abstractmethod
    def start(self) -> None:
        pass

    @abstractmethod
    def read_pose(self) -> Pose:
        ...

    @abstractmethod
    def stop(self) -> None:
        pass
